/* WorkSuite installer footer: "Quit installer" left, Back and the primary action right (design: Installer). */
import io.calamares.ui 1.0
import io.calamares.core 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

Rectangle {
    id: nav
    implicitHeight: 88
    color: "#0A1A3D"
    Rectangle { anchors.top: parent.top; width: parent.width; height: 1; color: "#1A2A55" }

    component NavButton: Rectangle {
        id: b
        property string label
        property bool primary: false
        property bool quiet: false
        signal activated()
        implicitHeight: 46
        implicitWidth: t.implicitWidth + (quiet ? 40 : 52)
        radius: 10
        opacity: enabled ? 1 : 0.4
        color: primary ? (ma.pressed ? "#1758D6" : "#1F6BFF") : (ma.containsMouse && enabled ? "#14FFFFFF" : "transparent")
        border.width: primary || quiet ? 0 : 1
        border.color: "#407FB2FF"
        activeFocusOnTab: enabled
        Accessible.role: Accessible.Button
        Accessible.name: label
        Keys.onReturnPressed: if (enabled) activated()
        Keys.onSpacePressed: if (enabled) activated()
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
        anchors.leftMargin: 72; anchors.rightMargin: 72
        spacing: 12
        NavButton {
            label: qsTr("Quit installer"); quiet: true
            visible: ViewManager.quitVisible; enabled: ViewManager.quitEnabled
            onActivated: ViewManager.quit()
        }
        Item { Layout.fillWidth: true }
        NavButton {
            label: ViewManager.backLabel
            visible: ViewManager.backAndNextVisible; enabled: ViewManager.backEnabled
            onActivated: ViewManager.back()
        }
        NavButton {
            label: ViewManager.nextLabel.replace("&", "") === "Next" ? qsTr("Continue") : ViewManager.nextLabel; primary: true
            visible: ViewManager.backAndNextVisible; enabled: ViewManager.nextEnabled
            onActivated: ViewManager.next()
        }
    }
}
