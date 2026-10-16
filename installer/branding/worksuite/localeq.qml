/* Step 4 · Region and city (design: Installer sub-steps › 4 · Region and city). Custom install only; Express keeps
   the default (localeq.conf) and passes over it. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15

WsPage {
    id: page
    stepIndex: 4
    eyebrow: qsTr("Step 4 · Region and city")
    title: qsTr("Where are you?")
    skipInExpress: true
    property string region: config.currentLocation ? config.currentLocation.region : ""
    onActivated: config.regionalZonesModel.region = region

    function indexOfKey(m, key) {
        for (var i = 0; i < m.rowCount(); i++)
            if (m.data(m.index(i, 0), 256 /* KeyRole = Qt::UserRole */) === key) return i
        return -1
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 20

        // Current choice.
        Rectangle {
            Layout.fillWidth: true; implicitHeight: 50
            radius: 12; color: "#145FD39A"; border.width: 1; border.color: "#595FD39A"
            RowLayout {
                anchors.fill: parent; anchors.leftMargin: 16; anchors.rightMargin: 16; spacing: 12
                Text { text: "✓"; color: "#5FD39A"; font.pixelSize: 16; font.weight: Font.Bold }
                Text {
                    Layout.fillWidth: true
                    text: "<b>" + qsTr("Time zone") + "</b> · " + config.currentTimezoneName
                    textFormat: Text.StyledText; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 14; elide: Text.ElideRight
                }
            }
        }

        // Dotted world panel with the selected place (the design's map, without geographic projection).
        Rectangle {
            Layout.fillWidth: true; Layout.preferredHeight: 260
            radius: 14; clip: true; color: "#081634"; border.width: 1; border.color: "#297FB2FF"
            // The design's dotted map background, tiled.
            Image { anchors.fill: parent; source: "dots.svg"; fillMode: Image.Tile; sourceSize.width: 14; sourceSize.height: 14 }
            Rectangle { id: band; x: parent.width * 0.66; width: 40; height: parent.height; color: "#2418D4F0"; border.width: 1; border.color: "#6618D4F0" }
            Rectangle {
                id: dot
                x: band.x + 12; y: 146; width: 16; height: 16; radius: 8; color: "#18D4F0"
                Rectangle { anchors.centerIn: parent; width: 28; height: 28; radius: 14; color: "#4018D4F0"; z: -1 }
            }
            Rectangle {
                x: band.x + 44; y: 130
                radius: 8; color: "#D9040A1A"; border.width: 1; border.color: "#337FB2FF"
                implicitWidth: tag.implicitWidth + 24; implicitHeight: tag.implicitHeight + 16
                Column {
                    id: tag; anchors.centerIn: parent; spacing: 2
                    Text { text: config.currentLocation ? config.currentLocation.name : ""; color: "#E8EEFA"; font.family: "IBM Plex Sans"; font.pixelSize: 14; font.weight: Font.DemiBold }
                    Text { text: config.currentTimezoneName; color: "#8FA3C8"; font.family: "IBM Plex Mono"; font.pixelSize: 12 }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 16
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 6
                WsLabel { text: qsTr("Region") }
                WsCombo {
                    Layout.fillWidth: true
                    model: config.regionModel; textRole: "name"
                    currentIndex: page.indexOfKey(config.regionModel, page.region)
                    onActivated: function (i) {
                        page.region = config.regionModel.data(config.regionModel.index(i, 0), 256)
                        config.regionalZonesModel.region = page.region
                    }
                }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.preferredWidth: 1; spacing: 6
                WsLabel { text: qsTr("City") }
                WsCombo {
                    Layout.fillWidth: true
                    model: config.regionalZonesModel; textRole: "name"
                    currentIndex: config.currentLocation && config.currentLocation.region === page.region
                        ? page.indexOfKey(config.regionalZonesModel, config.currentLocation.zone) : -1
                    onActivated: function (i) {
                        config.setCurrentLocation(page.region, config.regionalZonesModel.data(config.regionalZonesModel.index(i, 0), 256))
                    }
                }
            }
        }
        Item { Layout.fillHeight: true }
    }
}
