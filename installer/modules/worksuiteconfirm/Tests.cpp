#include "WorksuiteConfirmViewStep.h"
#include "WsIntro.h"
#include "WsStyle.h"

#include "GlobalStorage.h"
#include "JobQueue.h"

#include <QApplication>
#include <QCheckBox>
#include <QLineEdit>
#include <QTemporaryDir>
#include <QPointer>
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
    // WSOS-INS-006: "Skip for now" clears whatever was typed, leaves no token file and lets the installer go on;
    // Continue with both fields empty is the same.
    void enrollSkipWritesNoToken()
    {
        QTemporaryDir d;
        const QString pending = d.filePath( "enroll.json" );
        qputenv( "WORKSUITE_ENROLL_PENDING", QFile::encodeName( pending ) );
        Calamares::JobQueue jq;
        WorksuiteConfirmViewStep step;
        step.setConfigurationMap( { { "mode", "enroll" } } );
        QWidget* page = step.widget();
        const auto fields = page->findChildren< QLineEdit* >();
        QCOMPARE( fields.size(), 2 );
        QPushButton* skip = nullptr;
        for ( auto* b : page->findChildren< QPushButton* >() )
        {
            if ( b->text() == QStringLiteral( "Skip for now" ) )
            {
                skip = b;
            }
        }
        QVERIFY( skip );
        QVERIFY( skip->objectName() == QStringLiteral( "wsSecondary" ) );

        // Empty: Continue skips.
        step.onActivate();
        QVERIFY( step.isNextEnabled() );
        QVERIFY( !QFile::exists( pending ) );

        // A valid code is kept at once; Skip throws it away.
        fields[ 0 ]->setText( "ws.example.com" );
        fields[ 1 ]->setText( "wse_AbC-123_xyz" );
        QVERIFY( QFile::exists( pending ) );
        QVERIFY( jq.globalStorage()->value( "worksuiteEnroll" ).toBool() );
        skip->click();
        QVERIFY( !QFile::exists( pending ) );
        QVERIFY( fields[ 0 ]->text().isEmpty() && fields[ 1 ]->text().isEmpty() );
        QVERIFY( !jq.globalStorage()->value( "worksuiteEnroll" ).toBool() );
        QVERIFY( step.isNextEnabled() );

        // Half-typed (Continue disabled): Skip still gets past, with nothing written.
        fields[ 1 ]->setText( "wse_" );
        QVERIFY( !step.isNextEnabled() );
        skip->click();
        QVERIFY( step.isNextEnabled() );
        QVERIFY( !QFile::exists( pending ) );
        qunsetenv( "WORKSUITE_ENROLL_PENDING" );
    }
    void termsFiles()
    {
        using S = WorksuiteConfirmViewStep;
        QTemporaryDir d;
        for ( const char* l : { "en", "si" } )
        {
            QFile f( d.filePath( QStringLiteral( "LICENSE-%1.txt" ).arg( l ) ) );
            QVERIFY( f.open( QIODevice::WriteOnly ) );
            f.write( "Draft\nVersion: 0.1-draft\n" );
        }
        QCOMPARE( S::termsFile( d.path(), "si_LK" ), d.filePath( "LICENSE-si.txt" ) );
        QCOMPARE( S::termsFile( d.path(), "ta" ), d.filePath( "LICENSE-en.txt" ) );
        QCOMPARE( S::termsFile( d.filePath( "none" ), "en" ), QString() );
        QCOMPARE( S::termsVersion( "Title\nVersion: 0.1-draft \nText" ), QStringLiteral( "0.1-draft" ) );
        QCOMPARE( S::termsVersion( "no version" ), QStringLiteral( "unversioned" ) );
    }
    // The terms page holds Install back until the box is ticked; the acceptance (version, time) is recorded.
    void termsGateInstall()
    {
        QTemporaryDir d;
        QFile f( d.filePath( "LICENSE-en.txt" ) );
        QVERIFY( f.open( QIODevice::WriteOnly ) );
        f.write( "WorkSuite OS Terms\nVersion: 0.1-draft\n" );
        f.close();
        qputenv( "WORKSUITE_TERMS_DIR", QFile::encodeName( d.path() ) );
        Calamares::JobQueue jq;
        WorksuiteConfirmViewStep step;
        step.setConfigurationMap( { { "mode", "terms" } } );
        step.onActivate();
        QVERIFY( !step.isNextEnabled() );
        QVERIFY( !jq.globalStorage()->contains( "worksuiteTerms" ) );
        auto* box = step.widget()->findChild< QCheckBox* >();
        QVERIFY( box && !box->isChecked() );
        box->click();
        QVERIFY( step.isNextEnabled() );
        const QVariantMap rec = jq.globalStorage()->value( "worksuiteTerms" ).toMap();
        QCOMPARE( rec.value( "version" ).toString(), QStringLiteral( "0.1-draft" ) );
        QVERIFY( !rec.value( "acceptedAt" ).toString().isEmpty() );
        step.setTermsAccepted( false );
        QVERIFY( !step.isNextEnabled() );
        QVERIFY( !jq.globalStorage()->contains( "worksuiteTerms" ) );

        // Unattended images: `accepted: true` in the instance config.
        WorksuiteConfirmViewStep oem;
        oem.setConfigurationMap( { { "mode", "terms" }, { "accepted", true } } );
        oem.onActivate();
        QVERIFY( oem.isNextEnabled() );
        qunsetenv( "WORKSUITE_TERMS_DIR" );
    }
    // The loading curtain covers the window (QML pages hidden under it), then fades into it and goes.
    void introCurtain()
    {
        QWidget main;
        main.setObjectName( QStringLiteral( "mainApp" ) );
        main.resize( 1024, 768 );
        auto* page = new QWindow;
        auto* qml = QWidget::createWindowContainer( page, &main );
        qml->setGeometry( 260, 0, 764, 700 );
        main.show();
        QTRY_VERIFY( page->isVisible() );
        WsIntro::Options o;
        o.enabled = true;
        o.title = QStringLiteral( "Starting the installer…" );
        QPointer< QWidget > c = WsIntro::cover( &main, o );
        QVERIFY( c && c->isVisible() && c->geometry() == main.rect() );
        QVERIFY( !page->isVisible() );   // the page's own window is unmapped under the curtain
        QTRY_VERIFY_WITH_TIMEOUT( c.isNull(), 4000 );
        QVERIFY( page->isVisible() && qml->isVisible() );
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
