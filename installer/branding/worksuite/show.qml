/* Install progress (design: "WorkSuite OS Boot & Install" › Install progress). Calamares draws the progress bar
   and status line under this; stylesheet.qss gives them the design's gradient. */
import QtQuick 2.15
import calamares.slideshow 1.0

Presentation {
    id: presentation
    Timer { interval: 9000; running: presentation.activatedInCalamares; repeat: true; onTriggered: presentation.goToNextSlide() }

    component Card: Slide {
        property string heading
        property string body
        Rectangle {
            anchors.fill: parent
            gradient: Gradient {
                GradientStop { position: 0.0; color: "#12306B" }
                GradientStop { position: 0.65; color: "#0A1A3D" }
            }
        }
        Column {
            anchors.centerIn: parent
            width: Math.min(parent.width - 96, 640)
            spacing: 14
            Image { source: "logo.svg"; sourceSize.width: 46; sourceSize.height: 58; anchors.horizontalCenter: parent.horizontalCenter }
            Item { width: 1; height: 6 }
            Text { text: qsTr("Installing WorkSuite OS"); color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 34; font.weight: Font.Bold; anchors.horizontalCenter: parent.horizontalCenter }
            Text { text: qsTr("This takes a few minutes. Keep your computer plugged in."); color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 15; anchors.horizontalCenter: parent.horizontalCenter }
            Item { width: 1; height: 28 }
            Rectangle {
                width: parent.width; height: tip.implicitHeight + 48; radius: 16
                color: "#B80E2048"; border.width: 1; border.color: "#297FB2FF"
                Column {
                    id: tip
                    anchors.fill: parent; anchors.margins: 24
                    spacing: 6
                    Text { text: heading; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 16; font.weight: Font.DemiBold; width: parent.width; wrapMode: Text.WordWrap }
                    Text { text: body; color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 14; width: parent.width; wrapMode: Text.WordWrap }
                }
            }
        }
    }
    Card { heading: qsTr("Encrypted from the start"); body: qsTr("The whole disk is encrypted. Keep the recovery key shown at the end somewhere safe.") }
    Card { heading: qsTr("Your work follows you"); body: qsTr("Sign in with your WorkSuite account and your apps, files and settings sync.") }
    Card { heading: qsTr("Updates without interruptions"); body: qsTr("Updates install in the background and apply when you restart.") }
    Card { heading: qsTr("Apps from App Center"); body: qsTr("Install approved apps for work in one click, no admin password needed.") }

    function onActivate() { }
    function onLeave() { }
}
