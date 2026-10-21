// WorkSuite defaults for Firefox ESR (#49, #50), read from /etc/firefox-esr/. Firefox uses the system title bar:
// Labwc draws the WorkSuite title bar (Minimize, Maximize/Restore, Close; drag, snap, double-click to maximize) like
// every other window, instead of its own tab-strip buttons, which showed Close only. A default, not a lock:
// Customize Toolbar › Title Bar still changes it.
pref("browser.tabs.inTitlebar", 0);
