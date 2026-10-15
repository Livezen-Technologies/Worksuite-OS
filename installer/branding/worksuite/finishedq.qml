/* Step 6 · Complete (design: Installer sub-steps › 6 · Complete). The recovery key was shown on the step before. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    id: page
    property int seconds: 30
    function onActivate() { if (!config.failed) countdown.start() }
    Timer { id: countdown; interval: 1000; repeat: true; onTriggered: { page.seconds--; if (page.seconds <= 0) { stop(); config.doRestart(true) } } }

    // Installation stopped (design: Installation failed): what failed, the technical details, what usually helps.
    ColumnLayout {
        visible: config.failed
        anchors.fill: parent   // inside WsPage's margins
        spacing: 18
        RowLayout {
            spacing: 18
            Rectangle {
                Layout.alignment: Qt.AlignTop
                width: 56; height: 56; radius: 16; color: "#24FF8A7A"
                Text { anchors.centerIn: parent; text: "!"; color: "#FF8A7A"; font.pixelSize: 28; font.weight: Font.Bold }
            }
            ColumnLayout {
                Layout.fillWidth: true; spacing: 6
                Text { text: qsTr("INSTALLATION STOPPED"); color: "#FF8A7A"; font.family: "IBM Plex Mono"; font.pixelSize: 12; font.letterSpacing: 1 }
                Text { Layout.fillWidth: true; text: config.failureMessage; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 28; font.weight: Font.Bold; wrapMode: Text.WordWrap; textFormat: Text.PlainText }
                Text { Layout.fillWidth: true; text: qsTr("WorkSuite OS was not installed. If the disk was already being changed, it may hold a partial install."); color: "#C9D6EE"; font.family: "IBM Plex Sans"; font.pixelSize: 15; wrapMode: Text.WordWrap }
            }
        }
        Rectangle {
            Layout.fillWidth: true; Layout.fillHeight: true
            radius: 14; color: "#99040A1A"; border.width: 1; border.color: "#247FB2FF"; clip: true
            ColumnLayout {
                anchors.fill: parent; spacing: 0
                Text {
                    Layout.margins: 14
                    text: qsTr("Technical details"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 13; font.weight: Font.DemiBold
                }
                Rectangle { Layout.fillWidth: true; height: 1; color: "#1F7FB2FF" }
                Flickable {
                    Layout.fillWidth: true; Layout.fillHeight: true; Layout.margins: 14
                    clip: true; contentHeight: details.implicitHeight
                    Text {
                        id: details
                        width: parent.width
                        text: config.failureDetails
                        color: "#C9D6EE"; font.family: "IBM Plex Mono"; font.pixelSize: 12; lineHeight: 1.5
                        wrapMode: Text.WrapAnywhere; textFormat: Text.PlainText
                    }
                }
            }
        }
        Rectangle {
            Layout.fillWidth: true
            implicitHeight: tip.implicitHeight + 24
            radius: 12; color: "#141F6BFF"; border.width: 1; border.color: "#4D1F6BFF"
            Text {
                id: tip
                anchors.fill: parent; anchors.margins: 12
                text: "<b>" + qsTr("Usually fixed by:") + "</b> " + qsTr("restarting and installing again. If it keeps failing, the disk may be in use or failing; the full log is in /root/.cache/calamares/session.log.")
                textFormat: Text.StyledText; color: "#C9D6EE"; font.family: "IBM Plex Sans"; font.pixelSize: 13; wrapMode: Text.WordWrap
            }
        }
    }

    ColumnLayout {
        visible: !config.failed
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
            Layout.alignment: Qt.AlignHCenter; Layout.topMargin: 8
            text: config.failed ? qsTr("STEP 6 · FAILED") : qsTr("STEP 6 · COMPLETE")
            color: config.failed ? "#FF9F5A" : "#5FD39A"; font.family: "IBM Plex Mono"; font.pixelSize: 12; font.letterSpacing: 1
        }
        Text {
            Layout.alignment: Qt.AlignHCenter
            text: config.failed ? qsTr("Installation failed") : qsTr("WorkSuite OS is installed")
            color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 36; font.weight: Font.Bold; font.letterSpacing: -0.7
        }
        Text {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap; lineHeight: 1.4
            text: config.failed ? config.failureMessage + (config.failureDetails ? "\n" + config.failureDetails : "")
                : qsTr("Remove the installation media, then restart to sign in.")
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
