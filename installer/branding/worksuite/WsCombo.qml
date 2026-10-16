/* The design's 44 px select. Works on Calamares' list models: textRole "label" (or "name"). */
import QtQuick 2.15
import QtQuick.Controls.Basic 2.15

ComboBox {
    id: c
    implicitHeight: 44
    font.family: "IBM Plex Sans"; font.pixelSize: 14
    leftPadding: 14
    contentItem: Text {
        leftPadding: 0; rightPadding: c.indicator.width
        text: c.displayText; color: "#E8EEFA"; font: c.font
        verticalAlignment: Text.AlignVCenter; elide: Text.ElideRight
    }
    indicator: Text {
        x: c.width - width - 14; y: (c.height - height) / 2
        text: "▾"; color: "#8FA3C8"; font.pixelSize: 14
    }
    background: Rectangle {
        radius: 10; color: "#800A1A3D"
        border.width: 1; border.color: c.activeFocus || c.popup.visible ? "#7FB2FF" : "#407FB2FF"
    }
    delegate: ItemDelegate {
        width: c.width - 12
        highlighted: c.highlightedIndex === index
        contentItem: Text {
            text: model[c.textRole]; color: "#E8EEFA"; font: c.font; elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
        }
        background: Rectangle { radius: 8; color: highlighted ? "#1F6BFF" : "transparent" }
    }
    popup: Popup {
        y: c.height + 4; width: c.width; padding: 6
        implicitHeight: Math.min(contentItem.implicitHeight + 12, 320)
        contentItem: ListView {
            clip: true; implicitHeight: contentHeight; spacing: 2
            model: c.popup.visible ? c.delegateModel : null
            currentIndex: c.highlightedIndex
        }
        background: Rectangle { radius: 12; color: "#0F2350"; border.width: 1; border.color: "#337FB2FF" }
    }
}
