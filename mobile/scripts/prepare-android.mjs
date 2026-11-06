import { readFile, writeFile } from 'node:fs/promises';

const manifestPath = new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url);
let manifest = await readFile(manifestPath, 'utf8');

manifest = manifest.replace(
  /\s*<intent-filter>\s*<action android:name="android\.intent\.action\.MAIN"\s*\/>\s*<category android:name="android\.intent\.category\.LAUNCHER"\s*\/>\s*<\/intent-filter>/,
  ''
);

if (!manifest.includes('cl.pipevs.asistencia.LauncherAzul')) {
  const additions = `
        <meta-data
            android:name="com.google.firebase.messaging.default_notification_icon"
            android:resource="@drawable/notification_badge" />
        <meta-data
            android:name="com.google.firebase.messaging.default_notification_color"
            android:resource="@color/notification_icon_color" />

        <activity-alias
            android:name=".LauncherAzul"
            android:enabled="true"
            android:exported="true"
            android:icon="@mipmap/ic_launcher_azul"
            android:roundIcon="@mipmap/ic_launcher_azul"
            android:label="@string/app_name"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>
        <activity-alias
            android:name=".LauncherEsmeralda"
            android:enabled="false"
            android:exported="true"
            android:icon="@mipmap/ic_launcher_esmeralda"
            android:roundIcon="@mipmap/ic_launcher_esmeralda"
            android:label="@string/app_name"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>
        <activity-alias
            android:name=".LauncherVioleta"
            android:enabled="false"
            android:exported="true"
            android:icon="@mipmap/ic_launcher_violeta"
            android:roundIcon="@mipmap/ic_launcher_violeta"
            android:label="@string/app_name"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>
        <activity-alias
            android:name=".LauncherCoral"
            android:enabled="false"
            android:exported="true"
            android:icon="@mipmap/ic_launcher_coral"
            android:roundIcon="@mipmap/ic_launcher_coral"
            android:label="@string/app_name"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity-alias>
`;
  manifest = manifest.replace(/\s*<\/application>/, `${additions}    </application>`);
}

if (!manifest.includes('cl.pipevs.asistencia.LauncherAzul')) {
  throw new Error('No se pudieron incorporar los iconos alternativos al manifiesto.');
}

await writeFile(manifestPath, manifest, 'utf8');
