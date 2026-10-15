/* Step 6 · Copy files / Configure system (design: Installer sub-steps › 6 · Copy files, 6 · Configure system).
   Calamares draws the progress bar and the current job's status line under this (stylesheet.qss styles them);
   the slideshow itself cannot see the progress, so it lists what the install does. */
import QtQuick 2.15
import QtQuick.Layouts 1.15
import calamares.slideshow 1.0

Presentation {
    id: presentation
    Slide {
        // Rendered at exactly its on-screen size: a scaled image ran Qt's AVX2 image scaler, which crashed the live
        // session (segfault in libQt6Gui) on the time zone and install pages.
        Image { anchors.fill: parent; source: "page-bg.svg"; sourceSize: Qt.size(Math.max(1, width), Math.max(1, height)); smooth: false; cache: false }
        ColumnLayout {
            anchors.fill: parent
            anchors.leftMargin: 56; anchors.rightMargin: 56; anchors.topMargin: 40; anchors.bottomMargin: 16
            spacing: 24
            ColumnLayout {
                spacing: 6
                Text { text: qsTr("STEP 6 · INSTALL"); color: "#18D4F0"; font.family: "IBM Plex Mono"; font.pixelSize: 12; font.letterSpacing: 1 }
                Text { text: qsTr("Installing WorkSuite OS"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 30; font.weight: Font.Bold; font.letterSpacing: -0.6 }
                Text { text: qsTr("Keep the computer plugged in. You can't go back from here."); color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 15 }
            }
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: list.implicitHeight + 32
                radius: 16; color: "#990E2048"; border.width: 1; border.color: "#247FB2FF"
                ColumnLayout {
                    id: list
                    anchors.fill: parent; anchors.margins: 16
                    spacing: 4
                    Repeater {
                        model: [
                            [qsTr("Copy files"), qsTr("Partition and encrypt the disk, then unpack the system image")],
                            [qsTr("Configure system"), qsTr("Create your account, set the computer name, time zone, keyboard and language")],
                            [qsTr("Set up startup"), qsTr("Install the bootloader and prepare disk unlocking")],
                            [qsTr("Recovery key"), qsTr("Generate the key that can unlock your disk if you forget the passphrase")]
                        ]
                        RowLayout {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 52
                            spacing: 14
                            Rectangle {
                                width: 28; height: 28; radius: 14; color: "#2E1F6BFF"
                                Text { anchors.centerIn: parent; text: String(index + 1); color: "#7FB2FF"; font.family: "IBM Plex Mono"; font.pixelSize: 12; font.weight: Font.DemiBold }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true; spacing: 2
                                Text { text: modelData[0]; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 15; font.weight: Font.Medium }
                                Text { Layout.fillWidth: true; text: modelData[1]; color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 13; elide: Text.ElideRight }
                            }
                        }
                    }
                }
            }
            Item { Layout.fillHeight: true }
        }
    }
}
