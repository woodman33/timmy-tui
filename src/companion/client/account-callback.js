// R11 round 4 (H173): the launch token across Clerk's OAuth round trip. Loaded BEFORE companion.js, which reads the token
// from the address fragment (#t=…) and keeps it in memory only. "Continue with Google / GitHub" leaves this page for the
// provider and comes back to /account/callback without the fragment; account.js put the token in this tab's sessionStorage
// just before leaving (this origin only), and this script puts it back into the fragment here, then deletes it, so
// companion.js reads it as it always does. Any other page, or no saved token: nothing happens (the page says to open it from
// Timmy, as it does without a token). The token never reaches a server, a log or the provider.
(() => {
  'use strict';
  try {
    if (location.pathname.replace(/\/$/, '') !== '/account/callback') return;
    const saved = sessionStorage.getItem('timmy.account.launch');
    sessionStorage.removeItem('timmy.account.launch');
    if (!saved || !/^[0-9a-f]{64}$/.test(saved) || /(?:^#|&)t=/.test(location.hash)) return;
    history.replaceState(null, '', location.pathname + location.search + '#t=' + saved);
  } catch (e) { /* no storage or no history here: the page asks to be opened from Timmy */ }
})();
