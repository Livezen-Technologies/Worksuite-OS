import QtQuick 2.0;
import calamares.slideshow 1.0;

Presentation {
    id: presentation
    Slide {
        Text {
            anchors.centerIn: parent
            text: qsTr("Installing WorkSuite OS. Your apps, files and settings sync when you sign in.")
            wrapMode: Text.WordWrap
            width: parent.width * 0.8
            horizontalAlignment: Text.AlignHCenter
        }
    }
    function onActivate() { }
    function onLeave() { }
}
