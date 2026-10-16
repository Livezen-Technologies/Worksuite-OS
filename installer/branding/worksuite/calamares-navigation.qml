/* WorkSuite installer footer: "Quit installer" left, Back and the primary action right (design: Installer).
   A page with sub-steps of its own (Your account) reports them through WsState; Back and Continue then move
   between its sub-steps before moving between Calamares steps. */
import io.calamares.ui 1.0
import io.calamares.core 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: nav
    implicitHeight: 80
    color: "#0A1A3D"

    property WsState state: WsState {}
    property int subCount: 0
    property int subStep: 0
    property bool subNextOk: true
    property bool installFailed: false
    // settings.conf sequence ends: ... install, recovery key (last - 1), finished (last). Counted from the end so an
    // added page before the install (e.g. enroll) never shifts these.
    readonly property int lastStep: ViewManager.rowCount() - 1
    readonly property bool afterInstall: ViewManager.currentStepIndex >= lastStep - 1
    readonly property bool atEnd: ViewManager.currentStepIndex >= lastStep
    Timer {
        interval: 150; running: true; repeat: true; triggeredOnStart: true
        onTriggered: {
            nav.subCount = nav.state.get("subCount", 0)
            nav.subStep = nav.state.get("subStep", 0)
            nav.subNextOk = nav.state.get("subNextOk", true)
            nav.installFailed = nav.state.get("installFailed", false)
        }
    }
    readonly property bool inSubs: subCount > 1
    function request(dir) {
        nav.state.set("subRequest", dir + ":" + Date.now())
        nav.subStep += dir === "next" ? 1 : -1   // shown at once; the page confirms on its next report
    }
    Rectangle { anchors.top: parent.top; width: parent.width; height: 1; color: "#1F7FB2FF" }   // rgba(127,178,255,0.12)

    component NavButton: Rectangle {
        id: b
        property string label
        property bool primary: false
        property bool quiet: false
        signal activated()
        implicitHeight: 46
        implicitWidth: t.implicitWidth + (quiet ? 40 : primary ? 56 : 48)
        radius: 10
        opacity: enabled ? 1 : 0.4
        color: primary ? (ma.pressed ? "#1758D6" : ma.containsMouse ? "#3A7DFF" : "#1F6BFF") : (ma.containsMouse && enabled ? "#14FFFFFF" : "transparent")
        border.width: primary || quiet ? 0 : 1
        border.color: "#407FB2FF"
        activeFocusOnTab: enabled
        Accessible.role: Accessible.Button
        Accessible.name: label
        Keys.onReturnPressed: if (enabled) activated()
        Keys.onSpacePressed: if (enabled) activated()
        // The design's glow under the primary button (0 8px 24px rgba(31,107,255,0.35)), as soft stacked layers.
        Repeater {
            model: b.primary && b.enabled ? 6 : 0
            Rectangle {
                z: -1
                x: -index * 2; y: 8 - index * 2 + 2; width: b.width + index * 4; height: b.height + index * 4 - 4
                radius: b.radius + index * 2; color: "#1F6BFF"; opacity: 0.09 - index * 0.012
            }
        }
        Rectangle { anchors.fill: parent; anchors.margins: -3; radius: 13; color: "transparent"; border.width: 2; border.color: "#7FB2FF"; visible: b.activeFocus }
        Text {
            id: t
            anchors.centerIn: parent
            text: b.label.replace("&", "")
            color: b.primary ? "#FFFFFF" : b.quiet ? "#8FA3C8" : "#E8EEFA"
            font.family: "IBM Plex Sans"; font.pixelSize: 15
            font.weight: b.primary ? Font.DemiBold : Font.Medium
        }
        MouseArea { id: ma; anchors.fill: parent; hoverEnabled: true; enabled: b.enabled; cursorShape: Qt.PointingHandCursor; onClicked: b.activated() }
    }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 56; anchors.rightMargin: 56
        spacing: 12
        NavButton {
            label: qsTr("Quit installer"); quiet: true
            // Nothing to quit once the system is installed (the recovery key must be read; Complete restarts). After a
            // failure the failure page needs a way out.
            visible: ViewManager.quitVisible
            enabled: ViewManager.quitEnabled && (!nav.afterInstall || nav.installFailed)
            onActivated: ViewManager.quit()
        }
        Item { Layout.fillWidth: true }
        NavButton {
            label: ViewManager.backLabel
            // Nothing to go back to once installed: no Back on the recovery key or Complete page.
            visible: ViewManager.backAndNextVisible && !nav.afterInstall; enabled: (nav.inSubs && nav.subStep > 0) || ViewManager.backEnabled
            onActivated: nav.inSubs && nav.subStep > 0 ? nav.request("back") : ViewManager.back()
        }
        NavButton {
            label: ViewManager.nextLabel.replace("&", "") === "Next" ? qsTr("Continue") : ViewManager.nextLabel; primary: true
            readonly property bool moreSubs: nav.inSubs && nav.subStep < nav.subCount - 1
            visible: ViewManager.backAndNextVisible && !nav.atEnd; enabled: moreSubs ? nav.subNextOk : ViewManager.nextEnabled
            onActivated: moreSubs ? nav.request("next") : ViewManager.next()
        }
    }
}
