import { Platform } from 'react-native';

const FUNCTIONS_BASE_URL = process.env.FUNCTIONS_BASE_URL || 'https://your-project.cloudfunctions.net';

export async function syncPulseLinkRequest(requestBody) {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/smsGatewayWebhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Sync failed: ${response.status}`);
  }
  return response.json();
}

export async function sendPinReply(pin, fromNumber, emergencyId) {
  const response = await fetch(`${FUNCTIONS_BASE_URL}/pinGateWebhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ Body: `PIN ${pin}`, From: fromNumber, emergencyId }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `PIN verify failed: ${response.status}`);
  }
  return response.json();
}
