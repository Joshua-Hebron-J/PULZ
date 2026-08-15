const { createHash } = require('crypto');

const LLAMAFILE_URL = process.env.LLAMAFILE_URL || 'http://localhost:8080/v1/chat/completions';

function hashBloodType(value) {
  return createHash('sha256').update((value || '').trim().toUpperCase()).digest('hex');
}

function hashPin(pin) {
  return createHash('sha256').update((pin || '').trim()).digest('hex');
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function buildBoundingBox(latitude, longitude, radiusKm) {
  const latDelta = radiusKm / 111.12;
  const lonDelta = radiusKm / (111.12 * Math.cos((latitude * Math.PI) / 180));
  return {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLng: longitude - lonDelta,
    maxLng: longitude + lonDelta,
  };
}

async function parseSmsWithLlamafile(rawSms) {
  if (!rawSms || typeof rawSms !== 'string') {
    throw new Error('Raw SMS text is required for llm parsing.');
  }

  const systemPrompt = `You are a privacy-first emergency SMS parser used by the PulseLink blood dispatch system.
  Input is a raw SMS message from a hospital or field coordinator. Output JSON only with the following keys:
  - blood_type: the required blood group as a normalized string (A+, A-, B+, B-, AB+, AB-, O+, O- or Unknown)
  - hospital_id: the hospital identifier or facility name extracted from the text
  - coordinates: a string or object containing latitude and longitude if present
  - safe_text: the original message with any PII redacted
  - pii_redacted: true or false
  - pii_items: a list of redacted fields or patterns
  - note: a sanitized, non-PII emergency summary
  Do not output anything else.`;

  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Raw SMS: ${rawSms}` },
    ],
    temperature: 0.1,
    max_tokens: 400,
  };

  const response = await fetch(LLAMAFILE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`llamafile parse error: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  const text = result?.choices?.[0]?.message?.content || result?.output || '';

  try {
    const parsed = JSON.parse(text);
    return {
      blood_type: parsed.blood_type || 'Unknown',
      hospital_id: parsed.hospital_id || '',
      coordinates: parsed.coordinates || '',
      safe_text: parsed.safe_text || parsed.note || rawSms,
      pii_redacted: Boolean(parsed.pii_redacted),
      pii_items: parsed.pii_items || [],
      note: parsed.note || parsed.safe_text || rawSms,
      blood_hash: hashBloodType(parsed.blood_type || 'Unknown'),
    };
  } catch (error) {
    throw new Error(`Unable to parse JSON from llamafile output: ${text}`);
  }
}

module.exports = {
  hashBloodType,
  hashPin,
  haversineDistance,
  buildBoundingBox,
  parseSmsWithLlamafile,
};