'use client';

/**
 * Loading and initialising Facebook's JavaScript SDK, once per page.
 *
 * The SDK is loaded on mount rather than inside the click handler. `FB.login`
 * opens a popup, and a browser only allows that from a real user gesture — an
 * `await` for a script download inside the handler breaks the causal chain the
 * popup blocker looks for, and the window is silently refused. Loading ahead of
 * time keeps the handler synchronous where it matters.
 *
 * Only the connect page imports this, so the third-party script is not on every
 * page of the app. `FB.AppEvents.logPageView()` from Meta's sample is
 * deliberately not called: it is analytics we neither need nor disclose.
 */

export interface FacebookLoginResponse {
  /** Present when `response_type: 'code'` was requested and consent succeeded. */
  code?: string;
  status?: string;
  authResponse?: unknown;
}

interface FacebookSdk {
  init(options: { appId: string; cookie: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: {
      config_id?: string;
      scope?: string;
      response_type?: string;
      override_default_response_type?: boolean;
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SCRIPT_ID = 'facebook-jssdk';

let pending: Promise<FacebookSdk> | undefined;

export interface FacebookSdkConfig {
  appId: string;
  graphVersion: string;
}

/**
 * Resolve once `FB` is initialised. Memoised: React strict mode mounts effects
 * twice in development, and two `<script>` tags would race to define `FB`.
 */
export function loadFacebookSdk(config: FacebookSdkConfig): Promise<FacebookSdk> {
  if (pending) return pending;

  pending = new Promise<FacebookSdk>((resolve, reject) => {
    if (window.FB) {
      resolve(window.FB);
      return;
    }

    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: config.appId,
        // The SDK's own cookie. Disclosed in the privacy policy.
        cookie: true,
        // No XFBML tags on our pages; parsing for them is wasted work.
        xfbml: false,
        version: config.graphVersion,
      });
      if (window.FB) resolve(window.FB);
      else reject(new Error('Facebook SDK initialised without defining FB'));
    };

    if (document.getElementById(SCRIPT_ID)) return;

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      // Reset so a later attempt can retry rather than await a dead promise.
      pending = undefined;
      reject(new Error('Facebook SDK failed to load'));
    };

    document.head.appendChild(script);
  });

  return pending;
}
