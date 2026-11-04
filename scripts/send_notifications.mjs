import webpush from 'web-push';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
const secret = process.env.NOTIFICATION_SECRET || '';
const publicKey = process.env.VAPID_PUBLIC_KEY || '';
const privateKey = process.env.VAPID_PRIVATE_KEY || '';
const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const firebaseAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '';

if (!appUrl || !secret || !publicKey || !privateKey) {
  throw new Error('Faltan APP_URL, NOTIFICATION_SECRET, VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY.');
}

webpush.setVapidDetails(subject, publicKey, privateKey);
let nativeMessaging = null;
if (firebaseAccountBase64) {
  const serviceAccount = JSON.parse(Buffer.from(firebaseAccountBase64, 'base64').toString('utf8'));
  initializeApp({ credential: cert(serviceAccount) });
  nativeMessaging = getMessaging();
}
const headers = { Authorization: `Bearer ${secret}`, 'X-Native-Push': '1' };
const dueResponse = await fetch(`${appUrl}/api/notifications/due`, { headers });
if (!dueResponse.ok) throw new Error(`No se pudieron consultar recordatorios: ${dueResponse.status}`);
const { jobs = [] } = await dueResponse.json();
const successful = [];
const expired_subscription_ids = [];
const expired_token_ids = [];

for (const job of jobs) {
  try {
    if (job.kind === 'android') {
      if (!nativeMessaging) throw new Error('Falta FIREBASE_SERVICE_ACCOUNT_BASE64.');
      await nativeMessaging.send({
        token: job.token,
        notification: { title: job.payload.title, body: job.payload.body },
        data: { url: job.payload.url || '/' },
        android: {
          priority: 'high',
          notification: { icon: 'notification_badge', color: '#1767cc', tag: job.payload.tag }
        }
      });
      successful.push({ kind: 'android', event_id: job.event_id, token_id: job.token_id,
        reminder_minutes: job.reminder_minutes });
    } else {
      await webpush.sendNotification(
        { endpoint: job.endpoint, keys: job.keys },
        JSON.stringify(job.payload),
        { TTL: 3600, urgency: 'high' }
      );
      successful.push({ kind: 'web', event_id: job.event_id,
        subscription_id: job.subscription_id, reminder_minutes: job.reminder_minutes });
    }
  } catch (error) {
    if (job.kind === 'android' && ['messaging/registration-token-not-registered',
        'messaging/invalid-registration-token'].includes(error.code)) {
      expired_token_ids.push(job.token_id);
    } else if (job.kind !== 'android' && (error.statusCode === 404 || error.statusCode === 410)) {
      expired_subscription_ids.push(job.subscription_id);
    } else {
      console.error(`No se pudo enviar la notificación ${job.event_id}:`, error.message);
    }
  }
}

if (successful.length || expired_subscription_ids.length || expired_token_ids.length) {
  const ack = await fetch(`${appUrl}/api/notifications/ack`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ successful, expired_subscription_ids, expired_token_ids })
  });
  if (!ack.ok) throw new Error(`No se pudo confirmar el envío: ${ack.status}`);
}

console.log(`Recordatorios encontrados: ${jobs.length}; enviados: ${successful.length}; suscripciones web vencidas: ${expired_subscription_ids.length}; dispositivos Android vencidos: ${expired_token_ids.length}.`);
