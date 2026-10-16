/* Installer choices shared between pages. Each Calamares page has its own QML engine and Global storage is
   read-only from QML; QSettings objects in one process share their values, so the pages meet in this file. */
import QtQuick 2.15
import QtCore

QtObject {
    property Settings store: Settings { location: "file:///run/worksuite-installer.conf" }
    function get(key, fallback) {
        var v = store.value(key, fallback)
        // Values read back from the file are strings.
        if (v === "true") return true
        if (v === "false") return false
        return typeof fallback === "number" ? Number(v) : v
    }
    function set(key, value) { store.setValue(key, value); store.sync() }
}
