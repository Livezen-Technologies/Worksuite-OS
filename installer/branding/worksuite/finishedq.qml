/* Final page (design: Installer › Complete). The recovery key was shown on the step before. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    id: page
    property int seconds: 30
    function onActivate() { if (!config.failed) countdown.start() }
    Timer { id: countdown; interval: 1000; repeat: true; onTriggered: { page.seconds--; if (page.seconds <= 0) { stop(); config.doRestart(true) } } }

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width, 620)
        spacing: 20
        Rectangle {
            Layout.alignment: Qt.AlignHCenter
            width: 96; height: 96; radius: 48; color: config.failed ? "#24FF9F5A" : "#245FD39A"
            Rectangle { anchors.centerIn: parent; width: 116; height: 116; radius: 58; color: config.failed ? "#0FFF9F5A" : "#0F5FD39A"; z: -1 }
            Text { anchors.centerIn: parent; text: config.failed ? "!" : "✓"; color: config.failed ? "#FF9F5A" : "#5FD39A"; font.pixelSize: 48; font.weight: Font.Bold }
        }
        Text {
            Layout.alignment: Qt.AlignHCenter; Layout.topMargin: 12
            text: config.failed ? qsTr("Installation failed") : qsTr("WorkSuite OS is installed")
            color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 38; font.weight: Font.Bold; font.letterSpacing: -0.7
        }
        Text {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap; lineHeight: 1.4
            text: config.failed ? config.failureMessage + (config.failureDetails ? "\n" + config.failureDetails : "")
                : qsTr("Remove the USB drive, then restart. Setup will finish the first time you sign in.")
            color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 16
        }
        RowLayout {
            Layout.alignment: Qt.AlignHCenter; Layout.topMargin: 16
            spacing: 12
            Rectangle {
                implicitWidth: k.implicitWidth + 48; implicitHeight: 46; radius: 10; color: "transparent"; border.width: 1; border.color: "#407FB2FF"
                Text { id: k; anchors.centerIn: parent; text: qsTr("Restart later"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 15; font.weight: Font.Medium }
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: countdown.stop() }
            }
            Rectangle {
                visible: !config.failed
                implicitWidth: r.implicitWidth + 64; implicitHeight: 46; radius: 10; color: "#1F6BFF"
                Text { id: r; anchors.centerIn: parent; text: qsTr("Restart now"); color: "#FFFFFF"; font.family: "IBM Plex Sans"; font.pixelSize: 15; font.weight: Font.DemiBold }
                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { countdown.stop(); config.doRestart(true) } }
            }
        }
        Text {
            Layout.alignment: Qt.AlignHCenter
            visible: !config.failed && countdown.running
            text: qsTr("Restarting automatically in %n second(s)", "", page.seconds)
            color: "#5E739C"; font.family: "IBM Plex Sans"; font.pixelSize: 13
        }
    }
}
