import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const decode = value => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const encode = value => Buffer.from(value).toString('base64url');
const publicKey = encode(Buffer.concat([Buffer.from([4]), decode(jwk.x), decode(jwk.y)]));

console.log(`ASISTENCIA_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log(`ASISTENCIA_NOTIFICATION_SECRET=${randomBytes(32).toString('base64url')}`);
