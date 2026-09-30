import { secureHeaders, NONCE } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';

// Pages are per-request by nature, no-store is the safest default.
const cacheControl = async (c, next) => {
  await next();
  if (!c.res.headers.get('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'private, no-store');
  }
};

const mountSecurity = (app) => {
  app.use(cacheControl);
  app.use(
    secureHeaders({
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-origin',
      crossOriginEmbedderPolicy: 'require-corp',
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        // NONCE stashes a per-request nonce instead of 'unsafe-inline'.
        scriptSrc: ["'self'", NONCE],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"]
      },
      // Deny APIs nothing uses; clipboardWrite stays for the Copy button.
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
        payment: [],
        usb: [],
        bluetooth: [],
        midi: [],
        magnetometer: [],
        gyroscope: [],
        accelerometer: [],
        displayCapture: [],
        screenWakeLock: [],
        hid: [],
        serial: [],
        clipboardRead: [],
        clipboardWrite: ['self']
      }
    })
  );

  app.use(
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.text('Request body too large', 413)
    })
  );
};

export default mountSecurity;
