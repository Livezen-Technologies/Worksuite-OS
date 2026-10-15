import QtQuick 2.0;
import calamares.slideshow 1.0;

Presentation {
    id: presentation
    Timer { interval: 8000; running: presentation.activatedInCalamares; repeat: true; onTriggered: presentation.goToNextSlide() }

    component Card: Slide {
        property string heading
        property string body
        Rectangle { anchors.fill: parent; color: "#0b1120" }
        Image { source: "logo.svg"; width: 60; height: 76; anchors.horizontalCenter: parent.horizontalCenter; y: parent.height * 0.18 }
        Text { id: h; text: heading; color: "white"; font.pixelSize: 26; font.bold: true
               anchors.horizontalCenter: parent.horizontalCenter; y: parent.height * 0.18 + 100 }
        Text { text: body; color: "#94a3b8"; font.pixelSize: 16; wrapMode: Text.WordWrap; width: parent.width * 0.7
               horizontalAlignment: Text.AlignHCenter; anchors.horizontalCenter: parent.horizontalCenter; anchors.top: h.bottom; anchors.topMargin: 16 }
    }
    Card { heading: qsTr("Welcome to WorkSuite OS"); body: qsTr("Your apps, files and settings sync when you sign in.") }
    Card { heading: qsTr("Encrypted from the start"); body: qsTr("The whole disk is encrypted. Keep the recovery key shown at the end somewhere safe.") }
    Card { heading: qsTr("Updates without interruptions"); body: qsTr("Updates install in the background and apply when you restart.") }
    Card { heading: qsTr("Apps from App Center"); body: qsTr("Install approved apps for work in one click, no admin password needed.") }

    function onActivate() { }
    function onLeave() { }
}
