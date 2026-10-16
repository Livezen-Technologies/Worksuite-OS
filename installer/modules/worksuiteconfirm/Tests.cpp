#include "WorksuiteConfirmViewStep.h"
#include "WsStyle.h"

#include <QApplication>
#include <QMessageBox>
#include <QWindow>
#include <QPushButton>
#include <QTimer>
#include <QtTest/QtTest>

class WorksuiteConfirmTests : public QObject
{
    Q_OBJECT
private slots:
    void diskFromJobs()
    {
        using S = WorksuiteConfirmViewStep;
        QCOMPARE( S::diskFromDescriptions( { "Create new GPT partition table on /dev/nvme0n1 (Samsung SSD 980).",
                                             "Create new 512MiB partition on /dev/nvme0n1 with file system fat32.",
                                             "Format partition /dev/nvme0n1p2 with luks2" } ),
                  QStringLiteral( "nvme0n1" ) );
        QCOMPARE( S::diskFromDescriptions( { "Create new MSDOS partition table on /dev/sda.", "Set flags on /dev/sda1" } ),
                  QStringLiteral( "sda" ) );
        // Two disks or none: refuse to guess.
        QCOMPARE( S::diskFromDescriptions( { "Erase /dev/sda", "Erase /dev/sdb" } ), QString() );
        QCOMPARE( S::diskFromDescriptions( { "Set hostname" } ), QString() );
    }
    void typedConfirmation()
    {
        using S = WorksuiteConfirmViewStep;
        QVERIFY( S::confirmationMatches( "nvme0n1", "nvme0n1" ) );
        QVERIFY( S::confirmationMatches( " /dev/nvme0n1 ", "nvme0n1" ) );
        QVERIFY( !S::confirmationMatches( "nvme0n", "nvme0n1" ) );
        QVERIFY( !S::confirmationMatches( "NVME0N1", "nvme0n1" ) );
        QVERIFY( !S::confirmationMatches( "", "" ) );
    }
    void diskHeader()
    {
        using S = WorksuiteConfirmViewStep;
        QString model, size;
        S::parseLsblk( "MODEL=\"\" SIZE=\"40G\"\n", model, size );
        QCOMPARE( model, QString() );
        QCOMPARE( size, QStringLiteral( "40G" ) );
        QCOMPARE( S::diskTitle( "vda", model, size ), QStringLiteral( "vda · 40G" ) );
        S::parseLsblk( "MODEL=\"Samsung SSD 980 \" SIZE=\"931.5G\"", model, size );
        QCOMPARE( S::diskTitle( "nvme0n1", model, size ), QStringLiteral( "Samsung SSD 980 · 931.5G (nvme0n1)" ) );
        QCOMPARE( S::diskTitle( "sda", "", "" ), QStringLiteral( "sda" ) );
    }
    void opTags()
    {
        using S = WorksuiteConfirmViewStep;
        QCOMPARE( S::opKind( "Clear mounts for partitioning operations on /dev/vda" ), QString() );
        QCOMPARE( S::opKind( "Create new GPT partition table on /dev/vda" ), QStringLiteral( "CREATE" ) );
        QCOMPARE( S::opKind( "Format partition /dev/vda2 with luks2" ), QStringLiteral( "FORMAT" ) );
        QCOMPARE( S::opKind( "Delete partition /dev/vda1" ), QStringLiteral( "DELETE" ) );
        QCOMPARE( S::opKind( "Set flags on /dev/vda1 to boot" ), QStringLiteral( "OTHER" ) );
        QVERIFY( S::encryptedFromDescriptions( { "Create new 40G partition on /dev/vda with file system luks2" } ) );
        QVERIFY( !S::encryptedFromDescriptions( { "Create new 40G partition on /dev/vda with file system ext4" } ) );
    }
    void dialogStyle()
    {
        const QString sheet = "/* c { } */ #mainApp { color: red; }\nQPushButton, QToolButton { padding: 8px; }\n"
                              "QMessageBox QLabel { color: #fff; }\nQDialog { background: #000; }";
        QCOMPARE( WorksuiteConfirmViewStep::dialogStyleSheet( sheet ),
                  QString( "QDialog QPushButton, QDialog QToolButton { padding: 8px; }\n"
                           "QMessageBox QLabel { color: #fff; }\nQDialog { background: #000; }\n" ) );
    }
    // The Encryption sub-step's strength meter scores as the design (S2bEncryption) does.
    void passphraseScore()
    {
        QCOMPARE( WsStyle::passphraseScore( QString() ), 0 );
        QCOMPARE( WsStyle::passphraseScore( "short" ), 0 );
        QCOMPARE( WsStyle::passphraseScore( "abcdefgh" ), 1 );
        QCOMPARE( WsStyle::passphraseScore( "abcdefgh1" ), 2 );
        QCOMPARE( WsStyle::passphraseScore( "abcdefghijk1" ), 3 );
        QCOMPARE( WsStyle::passphraseScore( "correct-horse-42" ), 4 );
    }
    // The Quit dialog under cage: a dialog in a window of its own never showed (only the dim did). It is embedded in the
    // installer's main window, over the dim, and still returns its answer from exec().
    void dialogsEmbedInTheMainWindow()
    {
        QWidget main;
        main.setObjectName( QStringLiteral( "mainApp" ) );
        main.resize( 1024, 768 );
        auto* page = new QWidget( &main );
        // The QML page: a window container (and QQuickWidgets) composite over plain widgets, so it is hidden while the
        // dialog is up and shown again after (the real installer showed a dimmed window with no card).
        auto* qml = QWidget::createWindowContainer( new QWindow, &main );
        qml->setGeometry( 260, 0, 764, 700 );
        main.show();
        QMessageBox mb( QMessageBox::Question, "Cancel installation?", "Do you really want to cancel?",
                        QMessageBox::Yes | QMessageBox::No, page );
        WsStyle::prepareDialog( &mb );   // Calamares' constructor-time title change runs this in the installer
        QVERIFY( !mb.isWindow() );
        QCOMPARE( mb.parentWidget(), &main );
        QVERIFY( WsStyle::isDialogSurface( &mb ) );
        QVERIFY( !WsStyle::isDialogSurface( page ) );
        bool shownOverDim = false;
        QTimer::singleShot( 50, &mb, [ & ] {
            WsStyle::styleDialog( &mb );   // the installer's Show filter
            QCoreApplication::processEvents();
            auto* dim = main.findChild< QWidget* >( QStringLiteral( "wsDlgDim" ) );
            const auto kids = main.children();
            shownOverDim = mb.isVisible() && dim && dim->isVisible() && kids.indexOf( &mb ) > kids.indexOf( dim ) && !qml->isVisible();
            mb.button( QMessageBox::No )->click();
        } );
        QCOMPARE( mb.exec(), int( QMessageBox::No ) );
        QVERIFY( shownOverDim );
        WsStyle::dialogHidden( &mb );   // the installer's Hide filter
        QVERIFY( qml->isVisible() );
    }
    void sizeText()
    {
        QCOMPARE( WsStyle::sizeText( 512ll * 1024 * 1024 ), QStringLiteral( "512 MiB" ) );
        QCOMPARE( WsStyle::sizeText( 40ll * 1024 * 1024 * 1024 ), QStringLiteral( "40.00 GiB" ) );
        QCOMPARE( WsStyle::sizeText( qint64( 39.5 * 1024 * 1024 * 1024 ) ), QStringLiteral( "39.50 GiB" ) );
    }
};

// Widgets (the dialog test) need a QApplication; offscreen, so the package build needs no display.
int
main( int argc, char** argv )
{
    if ( qEnvironmentVariableIsEmpty( "QT_QPA_PLATFORM" ) )
    {
        qputenv( "QT_QPA_PLATFORM", "offscreen" );
    }
    QApplication app( argc, argv );
    WorksuiteConfirmTests t;
    return QTest::qExec( &t, argc, argv );
}
#include "Tests.moc"
