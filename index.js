const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { buildBoundingBox, haversineDistance, hashPin, parseSmsWithLlamafile, hashBloodType } = require('./llamafile');
const fetch = global.fetch || require('node-fetch');

admin.initializeApp();
const firestore = admin.firestore();
const rtdb = admin.database();

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const FUNCTION_BASE_URL = process.env.FUNCTION_BASE_URL || '';

function buildTwilioPayload(to, body) {
  const params = new URLSearchParams();
  params.append('From', TWILIO_FROM_NUMBER);
  params.append('To', to);
  params.append('Body', body);
  return params;
}

async function sendOutboundSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error('Twilio configuration missing. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.');
  }
  const payload = buildTwilioPayload(to, body);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: payload.toString(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio send failed: ${response.status} ${text}`);
  }
  return response.json();
}

async function findNearbyDonors({ lat, lng, bloodHash, maxDistanceKm = 12 }) {
  const donorsRef = firestore.collection('donors');
  const box = buildBoundingBox(lat, lng, maxDistanceKm);

  const donorSnapshot = await donorsRef
    .where('status', '==', 'available')
    .where('location.lat', '>=', box.minLat)
    .where('location.lat', '<=', box.maxLat)
    .get();

  const matchingDonors = [];
  donorSnapshot.forEach((doc) => {
    const donor = doc.data();
    const distance = haversineDistance(lat, lng, donor.location.lat, donor.location.lng);
    if (distance <= maxDistanceKm && donor.blood_hash === bloodHash) {
      matchingDonors.push({ id: doc.id, ...donor, distance });
    }
  });

  return matchingDonors.sort((a, b) => a.distance - b.distance);
}

function safeParseSmsPayload(body) {
  const raw = (body.Body || body.body || body.message || '') + '';
  const hospitalId = body.hospital_id || body.hospitalId || '';
  const bloodType = body.blood_type || body.bloodType || '';
  const coordinates = body.coordinates || body.coords || '';
  return { rawSms: raw.trim(), hospitalId, bloodType, coordinates };
}

async function parseCoordinates(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(/([-+]?\d{1,2}\.\d+)[,\s]+([-+]?\d{1,3}\.\d+)/);
    if (match) {
      return { lat: Number(match[1]), lng: Number(match[2]) };
    }
    return null;
  }
  if (typeof value === 'object' && value.lat && value.lng) {
    return { lat: Number(value.lat), lng: Number(value.lng) };
  }
  return null;
}

exports.smsGatewayWebhook = functions.https.onRequest(async (req, res) => {
  try {
    const payload = safeParseSmsPayload(req.body || {});
    if (!payload.rawSms) {
      return res.status(400).json({ error: 'Missing SMS text.' });
    }

    const parsed = await parseSmsWithLlamafile(payload.rawSms);
    const coordinates = await parseCoordinates(payload.coordinates || parsed.coordinates);
    if (!coordinates) {
      return res.status(400).json({ error: 'Unable to extract coordinates from SMS payload.' });
    }

    const bloodHash = parsed.blood_hash || hashBloodType(payload.bloodType || parsed.blood_type || 'Unknown');
    const hospitalId = payload.hospitalId || parsed.hospital_id || 'unknown';
    const emergencyId = `sms_${Date.now()}`;

    const nearbyDonors = await findNearbyDonors({ lat: coordinates.lat, lng: coordinates.lng, bloodHash });

    const emergencyDoc = {
      emergencyId,
      hospital_id: hospitalId,
      coordinates,
      raw_sms: payload.rawSms,
      note: parsed.safe_text,
      blood_type: parsed.blood_type || (payload.bloodType || 'Unknown'),
      blood_hash: bloodHash,
      pii_redacted: parsed.pii_redacted,
      pii_items: parsed.pii_items,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'searching',
      donorCount: nearbyDonors.length,
      donorIds: nearbyDonors.map((d) => d.id),
    };

    await firestore.collection('emergencies').doc(emergencyId).set(emergencyDoc);

    const blastText = `PulseLink Alert:\nHospital ${hospitalId} needs ${parsed.blood_type} near ${coordinates.lat.toFixed(3)}, ${coordinates.lng.toFixed(3)}. Reply with your 4-digit PIN to commit.`;
    const smsPromises = nearbyDonors.slice(0, 12).map((donor) => sendOutboundSms(donor.phone, blastText));
    await Promise.allSettled(smsPromises);

    return res.status(200).json({ success: true, emergencyId, donorsNotified: nearbyDonors.length });
  } catch (error) {
    console.error('smsGatewayWebhook error', error);
    return res.status(500).json({ error: error.message || 'Internal server error.' });
  }
});

exports.pinGateWebhook = functions.https.onRequest(async (req, res) => {
  try {
    const rawBody = req.body || {};
    const messageText = (rawBody.Body || rawBody.body || rawBody.message || '') + '';
    const fromNumber = rawBody.From || rawBody.from || rawBody.sender || '';
    const pinMatch = messageText.match(/\b(\d{4})\b/);
    if (!pinMatch) {
      return res.status(400).json({ error: 'PIN not found in message.' });
    }

    const pin = pinMatch[1];
    const hashedPin = hashPin(pin);
    const donorQuery = await firestore.collection('donors').where('pinHash', '==', hashedPin).limit(1).get();
    if (donorQuery.empty) {
      return res.status(404).json({ error: 'No donor found for this PIN.' });
    }

    const donorDoc = donorQuery.docs[0];
    const donor = donorDoc.data();
    const donorId = donorDoc.id;
    const emergencyId = donor.pendingEmergencyId || rawBody.emergencyId || ''; 

    const commitPath = rtdb.ref(`donorCommits/${donorId}`);
    await commitPath.set({
      donorId,
      emergencyId,
      verifiedAt: Date.now(),
      verifiedBy: fromNumber,
      status: 'committed',
      rawMessage: messageText,
    });

    await rtdb.ref(`donorStatus/${donorId}`).set({
      status: 'committed',
      emergencyId,
      committedAt: Date.now(),
    });

    await firestore.collection('audit').doc(`pin_commit_${Date.now()}_${donorId}`).set({
      event: 'pin_verified',
      donorId,
      emergencyId,
      fromNumber,
      pinHash: hashedPin,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      rawMessage: messageText,
    });

    if (emergencyId) {
      await firestore.collection('emergencies').doc(emergencyId).update({
        status: 'committed',
        committedDonorId: donorId,
        committedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.status(200).json({ success: true, donorId, emergencyId });
  } catch (error) {
    console.error('pinGateWebhook error', error);
    return res.status(500).json({ error: error.message || 'Internal server error.' });
  }
});
