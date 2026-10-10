/**
 * AdMobService — Rewarded ads + a top banner.
 *
 * Why rewarded-only during review: banner/interstitial ads mid-session
 * would hurt learning outcomes and ratings. A rewarded ad is always
 * user-initiated (they tap "watch ad to..."), so it never interrupts a
 * session. The banner is the opposite case - it's meant to just sit
 * there - so it's only shown on screens that aren't a review session:
 * Settings and the Add-word/situation screen (see showBannerAd callers
 * in App.jsx). It's anchored TOP_CENTER specifically so it never overlaps
 * the app's own bottom navigation bar, which is drawn by the WebView and
 * would otherwise sit underneath a native BOTTOM_CENTER banner.
 *
 * On web / browser preview this entire module is a silent no-op —
 * isNative() guards every native call and onRewarded() is called
 * immediately so the UI never gets stuck on web.
 *
 * IDs:
 *   App ID   : ca-app-pub-1668741011095023~9376063574
 *   Rewarded : ca-app-pub-1668741011095023/2507402892
 *   Banner   : ca-app-pub-1668741011095023/8347782279
 */
import { Capacitor } from "@capacitor/core";

const isNative = () => Capacitor.isNativePlatform();

const AD_IDS = {
  rewarded: "ca-app-pub-1668741011095023/2507402892",
  banner: "ca-app-pub-1668741011095023/8347782279",
};

let admob = null;
let initialized = false;

async function getAdMob() {
  if (!isNative()) return null;
  if (!admob) {
    const mod = await import("@capacitor-community/admob");
    admob = mod.AdMob;
  }
  if (!initialized) {
    await admob.initialize({ testingDevices: [], initializeForTesting: false });
    initialized = true;
  }
  return admob;
}

/**
 * Show a rewarded ad. onRewarded() is called ONLY when the reward is
 * actually earned (or on web/preview, where there is no ad network).
 * If the ad can't be shown on a real device (no fill, offline...), the
 * reward is NOT granted - otherwise "watch an ad to unlock" would be a
 * free unlock for anyone offline - and onFailed() is called so the UI can
 * tell the person to try again.
 *
 * Debug/CI builds (VITE_ADMOB_TESTING=true) use Google's official test
 * ad unit, so developers never click live ads on their own account.
 */
const TEST_REWARDED_ID = "ca-app-pub-3940256099942544/5224354917";
const TESTING = typeof import.meta !== "undefined" && import.meta.env?.VITE_ADMOB_TESTING === "true";

export async function showRewardedForStreak(onRewarded, onFailed) {
  let AdMob;
  try {
    AdMob = await getAdMob();
  } catch (err) {
    console.warn("AdMob init failed:", err?.message || err);
    if (onFailed) onFailed(err);
    return;
  }
  if (!AdMob) {
    // Web / preview - no ad network, grant immediately
    onRewarded();
    return;
  }
  try {
    await AdMob.prepareRewardVideoAd({ adId: TESTING ? TEST_REWARDED_ID : AD_IDS.rewarded, isTesting: TESTING });
    const result = await AdMob.showRewardVideoAd();
    if ((result && result.rewardAmount > 0) || result?.type === "rewarded") {
      onRewarded();
    } else if (onFailed) {
      onFailed(new Error("reward not earned"));
    }
  } catch (err) {
    console.warn("AdMob rewarded ad failed:", err?.message || err);
    if (onFailed) onFailed(err);
  }
}

/**
 * Banner ads. Google's official test banner ID is used for debug/CI
 * builds (VITE_ADMOB_TESTING=true), same policy as the rewarded ad.
 *
 * showBannerAd(placement) shows (or resizes/repositions, if already
 * showing) a top banner. Call hideBannerAd() when leaving that screen -
 * it hides rather than removes, so re-entering the same screen is instant
 * (removeBannerAd fully tears it down, used only on unexpected errors).
 * `placement` is just for logging/diagnostics (e.g. "settings", "add"),
 * it isn't sent to AdMob itself.
 */
const TEST_BANNER_ID = "ca-app-pub-3940256099942544/6300978111";

export async function showBannerAd(placement) {
  let AdMob;
  try {
    AdMob = await getAdMob();
  } catch (err) {
    console.warn(`AdMob banner (${placement}) init failed:`, err?.message || err);
    return;
  }
  if (!AdMob) return; // web/preview - no native banner to show
  try {
    const { BannerAdPosition, BannerAdSize } = await import("@capacitor-community/admob");
    await AdMob.showBanner({
      adId: TESTING ? TEST_BANNER_ID : AD_IDS.banner,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: BannerAdPosition.TOP_CENTER,
      isTesting: TESTING,
    });
  } catch (err) {
    console.warn(`AdMob banner (${placement}) failed to show:`, err?.message || err);
  }
}

export async function hideBannerAd() {
  if (!isNative()) return;
  try {
    if (admob) await admob.hideBanner();
  } catch {
    // no banner was showing - nothing to do
  }
}
