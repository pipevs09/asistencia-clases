import webpush from 'web-push';

const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
const secret = process.env.NOTIFICATION_SECRET || '';
const publicKey = process.env.VAPID_PUBLIC_KEY || '';
const privateKey = process.env.VAPID_PRIVATE_KEY || '';
const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!appUrl || !secret || !publicKey || !privateKey) {
  throw new Error('Faltan APP_URL, NOTIFICATION_SECRET, VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY.');
}

webpush.setVapidDetails(subject, publicKey, privateKey);
const headers = { Authorization: `Bearer ${secret}` };
const dueResponse = await fetch(`${appUrl}/api/notifications/due`, { headers });
if (!dueResponse.ok) throw new Error(`No se pudieron consultar recordatorios: ${dueResponse.status}`);
const { jobs = [] } = await dueResponse.json();
const successful = [];
const expired_subscription_ids = [];

for (const job of jobs) {
  try {
    await webpush.sendNotification(
      { endpoint: job.endpoint, keys: job.keys },
      JSON.stringify(job.payload),
      { TTL: 3600, urgency: 'high' }
    );
    successful.push({
      event_id: job.event_id,
      subscription_id: job.subscription_id,
      reminder_minutes: job.reminder_minutes
    });
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      expired_subscription_ids.push(job.subscription_id);
    } else {
      console.error(`No se pudo enviar la notificación ${job.event_id}:`, error.message);
    }
  }
}

if (successful.length || expired_subscription_ids.length) {
  const ack = await fetch(`${appUrl}/api/notifications/ack`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ successful, expired_subscription_ids })
  });
  if (!ack.ok) throw new Error(`No se pudo confirmar el envío: ${ack.status}`);
}

console.log(`Recordatorios encontrados: ${jobs.length}; enviados: ${successful.length}; suscripciones vencidas: ${expired_subscription_ids.length}.`);
