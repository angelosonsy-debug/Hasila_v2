/**
 * SettingsService
 * -----------------------------------------------------------------------
 * Single source of truth for default app settings and for scheduling the
 * daily local reminder notification.
 */

export const DEFAULT_SETTINGS = {
  level: null,
  // Words: known/review/new caps + an overall per-session ceiling.
  dailyNewCap: 8, dailyOldCap: 10, dailyReviewCap: 25, dailySessionCap: 40,
  // Situations: same protective system, mirrored with its own numbers.
  dailySituationNewCap: 8, dailySituationOldCap: 8, dailySituationReviewCap: 15, dailySituationSessionCap: 25,
  reminderHour: 21, reminderMinute: 0, accent: "us",
  habitAnchor: "", // optional "habit stacking" anchor, e.g. "بعد ما تصلي المغرب"
  remindersEnabled: true,
  // Whether the OS permission dialog has ever been shown to this person -
  // NOT whether they granted it. Once true, nothing in this file will
  // silently prompt again; only an explicit user action (the onboarding
  // "فعّل التذكير" button, or toggling reminders on in Settings) ever
  // triggers the native dialog after that. Respecting a "no" (or even an
  // unanswered prompt) permanently is the whole point of this flag.
  notificationPermissionAsked: false,
  // Premium: unlocks independent word + situation sessions each day.
  // Free tier allows only one session type per day (word OR situation).
  // Placeholder — real in-app purchase via Google Play Billing in future.
  isPremium: false,
};

/**
 * Daily-cap validation. `session` is the TOTAL maximum for a session;
 * new + old + review must never add up to more than it. Shrinking the
 * total auto-trims review first, then old, then new, so the person never
 * ends up with an impossible combination.
 */
export function clampCaps({ session, newC, oldC, review }) {
  const total = Math.max(0, Number(session) || 0);
  let n = Math.max(0, Number(newC) || 0);
  let o = Math.max(0, Number(oldC) || 0);
  let r = Math.max(0, Number(review) || 0);
  let over = n + o + r - total;
  if (over > 0) { const cut = Math.min(r, over); r -= cut; over -= cut; }
  if (over > 0) { const cut = Math.min(o, over); o -= cut; over -= cut; }
  if (over > 0) { const cut = Math.min(n, over); n -= cut; over -= cut; }
  return { session: total, newC: n, oldC: o, review: r };
}

/** Highest value a single cap can take given the other two and the total. */
export function capMax(caps, key) {
  const others = ["newC", "oldC", "review"].filter((k) => k !== key).reduce((a, k) => a + (Number(caps[k]) || 0), 0);
  return Math.max(0, (Number(caps.session) || 0) - others);
}

/** Fills in any settings keys missing from a saved/imported object (e.g.
 * settings saved by an older version of the app before new caps existed)
 * without ever dropping a value the person already customized. */
export function normalizeSettings(saved) {
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

function reminderBody(dueCount, habitAnchor) {
  const base = dueCount > 0 ? `عندك ${dueCount} كلمة مستنية مراجعتك 📚` : "وقت مراجعة كلماتك الإنجليزية 📚";
  return habitAnchor ? `${base}\n${habitAnchor}` : base;
}

/**
 * Explicit, user-initiated permission request - call this ONLY from a
 * direct tap on something like "فعّل التذكير اليومي" (onboarding or a
 * Settings toggle), never automatically on app load. Returns whether
 * permission ended up granted, so the caller can update
 * notificationPermissionAsked/remindersEnabled accordingly.
 */
export async function requestNotificationPermission() {
  try {
    if (typeof window === "undefined" || !window.Capacitor?.isNativePlatform?.()) return false;
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const perm = await LocalNotifications.requestPermissions();
    return perm.display === "granted";
  } catch (e) {
    console.error("notification permission request failed", e);
    return false;
  }
}

/**
 * (Re)schedules the daily reminder. Inside the Claude preview this just
 * no-ops (there's no background process here to fire a real alarm). Once
 * the app is packaged as the Android APK with
 * @capacitor/local-notifications, this schedules a real repeating daily
 * local notification using the phone's own OS scheduler - no internet
 * needed.
 *
 * IMPORTANT: this function never itself calls requestPermissions() - it
 * only schedules if permission was already granted previously (checked
 * via checkPermissions(), a read-only call that never shows a dialog). A
 * person who denied notifications, or never got asked, simply doesn't get
 * a scheduled reminder here - silently, without being re-prompted every
 * time they open the app. The only path to a permission dialog is
 * requestNotificationPermission() above, triggered by an explicit tap.
 *
 * dueCount/habitAnchor personalize the notification body ("clear cue" -
 * showing the actual number due, and an optional habit-stacking anchor
 * like "right after Maghrib prayer"). Because this is a *repeating* OS
 * alarm, the body text is fixed at scheduling time - it reflects the due
 * count as of the last time this was called (app open or settings save),
 * not a live count computed the instant the notification fires. That's a
 * real limitation of local-notifications-only reminders, not something
 * that can be fully solved without a background service.
 */
export async function scheduleReminder(hour, minute, dueCount = 0, habitAnchor = "", enabled = true) {
  try {
    if (typeof window === "undefined" || !window.Capacitor?.isNativePlatform?.()) return;
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    await LocalNotifications.cancel({ notifications: [{ id: 9001 }] });
    if (!enabled) return;
    const perm = await LocalNotifications.checkPermissions(); // read-only, never shows UI
    if (perm.display !== "granted") return;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: 9001,
          title: "حصيلتي",
          body: reminderBody(dueCount, habitAnchor),
          schedule: { on: { hour, minute }, repeats: true, allowWhileIdle: true },
        },
      ],
    });
  } catch (e) {
    console.error("reminder scheduling failed", e);
  }
}
