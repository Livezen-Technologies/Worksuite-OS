/* Step 1 · Language (design: Installer sub-steps › 1 · Language): install mode, then the language. Express fills
   in the keyboard and the time zone with defaults; Custom shows those pages. */
import io.calamares.core 1.0
import io.calamares.ui 1.0
import QtQuick 2.15
import QtQuick.Layouts 1.15
import QtQuick.Controls.Basic 2.15

WsPage {
    id: page
    stepIndex: 0
    eyebrow: qsTr("Step 1 · Language")
    title: qsTr("Choose your language")
    subtitle: qsTr("Used for the installer and your new system.")
    property bool expressChosen: page.state.get("express", true)
    onExpressChosenChanged: page.state.set("express", expressChosen)
    onActivated: page.state.set("express", expressChosen)
    readonly property real cardHeight: Math.max(expressCard.implicitHeight, customCard.implicitHeight)

    // The languages, read from Calamares' model once, and the ones the search shows. A JS list filtered in one pass
    // instead of a delegate per language testing the search on every key (which also left gaps in the grid).
    property var languages: []
    property var shown: []
    // The language just picked: highlighted at once; Calamares applies it a frame later (see choose()).
    property int pending: config.localeIndex
    property bool applying: false
    function load() {
        var m = config.languagesModel, out = []
        for (var i = 0; i < m.rowCount(); i++) {
            var ix = m.index(i, 0)
            // TranslationsModel roles: LabelRole = Qt::DisplayRole (0), EnglishLabelRole = Qt::UserRole + 1 (257).
            var label = m.data(ix, 0), english = m.data(ix, 257)
            if (english === undefined) english = label
            out.push({ index: i, label: label, english: english, key: (label + " " + english).toLowerCase() })
        }
        languages = out
        filter()
    }
    function filter() {
        var q = search.text.trim().toLowerCase()
        shown = q === "" ? languages : languages.filter(function (l) { return l.key.indexOf(q) >= 0 })
        if (q === "") grid.positionViewAtIndex(Math.max(0, config.localeIndex), GridView.Center)
    }
    function choose(i) {
        if (i === config.localeIndex) return
        pending = i
        applying = true
        applyTimer.restart()
    }
    // Lets the highlight and the busy line paint before the (synchronous) retranslation starts.
    Timer {
        id: applyTimer; interval: 30
        onTriggered: { config.localeIndex = page.pending; doneTimer.restart() }
    }
    Timer { id: doneTimer; interval: 0; onTriggered: page.applying = false }
    Connections {
        target: config
        function onLocaleIndexChanged() { page.pending = config.localeIndex }
    }
    Component.onCompleted: load()

    ColumnLayout {
        anchors.fill: parent
        spacing: 18

        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            WsChoice {
                id: expressCard
                Layout.fillWidth: true; Layout.preferredWidth: 1; Layout.preferredHeight: page.cardHeight
                title: qsTr("Express install")
                text: qsTr("Sensible defaults: US keyboard and Asia/Colombo time. You can change both later in Settings.")
                selected: page.expressChosen
                onPicked: page.expressChosen = true
            }
            WsChoice {
                id: customCard
                Layout.fillWidth: true; Layout.preferredWidth: 1; Layout.preferredHeight: page.cardHeight
                title: qsTr("Custom install")
                text: qsTr("Choose keyboard, time zone and every other setting yourself.")
                selected: !page.expressChosen
                onPicked: page.expressChosen = false
            }
        }

        WsField {
            id: search
            Layout.fillWidth: true; placeholderText: qsTr("Search languages")
            // Filter after a short pause in typing, not on every key.
            onTextChanged: filterTimer.restart()
            Keys.onReturnPressed: if (page.shown.length === 1) page.choose(page.shown[0].index)
        }
        Timer { id: filterTimer; interval: 150; onTriggered: page.filter() }

        Item {
            Layout.fillWidth: true; Layout.fillHeight: true
            GridView {
                id: grid
                anchors.fill: parent
                clip: true
                cellWidth: width / 3; cellHeight: 52
                cacheBuffer: 0
                reuseItems: true
                boundsBehavior: Flickable.StopAtBounds
                model: page.shown
                delegate: Item {
                    readonly property bool selected: modelData.index === page.pending
                    width: grid.cellWidth; height: grid.cellHeight
                    Rectangle {
                        anchors.fill: parent; anchors.rightMargin: 8; anchors.bottomMargin: 8
                        radius: 10
                        color: selected ? "#1F6BFF" : mouse.containsMouse ? "#B30E2048" : "#990E2048"
                        border.width: 1; border.color: selected ? "#1F6BFF" : "#247FB2FF"
                        RowLayout {
                            anchors.fill: parent; anchors.leftMargin: 14; anchors.rightMargin: 14
                            // Explicit left alignment: Qt otherwise right-aligns right-to-left native names (Persian, Hebrew).
                            Text { Layout.fillWidth: true; text: modelData.label; horizontalAlignment: Text.AlignLeft; LayoutMirroring.enabled: false; color: "#FFFFFF"; font.family: "IBM Plex Sans"; font.pixelSize: 14; elide: Text.ElideRight }
                            Text { text: modelData.english !== modelData.label ? modelData.english : ""; color: "#FFFFFF"; opacity: 0.75; font.family: "IBM Plex Sans"; font.pixelSize: 13; elide: Text.ElideRight; Layout.maximumWidth: 110 }
                        }
                        MouseArea { id: mouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: page.choose(modelData.index) }
                    }
                }
            }
            Text {
                anchors.centerIn: parent
                visible: page.shown.length === 0 && page.languages.length > 0
                text: qsTr("No language matches \"%1\".").arg(search.text)
                color: "#8FA3C8"; font.family: "IBM Plex Sans"; font.pixelSize: 14
            }
        }

        // Applying a language retranslates every page; the choice shows at once and this line while that runs.
        RowLayout {
            Layout.fillWidth: true
            visible: page.applying
            spacing: 10
            BusyIndicator { running: page.applying; implicitWidth: 20; implicitHeight: 20 }
            Text { text: qsTr("Applying the language…"); color: "#18D4F0"; font.family: "IBM Plex Sans"; font.pixelSize: 13 }
        }

        Rectangle {
            Layout.fillWidth: true
            visible: !config.requirementsModel.satisfiedRequirements
            implicitHeight: warn.implicitHeight + 28
            radius: 12; color: "#14FF9F5A"; border.width: 1; border.color: "#4DFF9F5A"
            Text {
                id: warn
                anchors.fill: parent; anchors.margins: 14
                text: config.warningMessage
                color: "#FFB98A"; font.family: "IBM Plex Sans"; font.pixelSize: 13; wrapMode: Text.WordWrap; textFormat: Text.StyledText
            }
        }
    }
}
