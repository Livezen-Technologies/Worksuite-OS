#include "WorksuiteConfirmViewStep.h"
#include "WsStyle.h"

#include "Branding.h"
#include "GlobalStorage.h"
#include "JobQueue.h"
#include "ViewManager.h"
#include "utils/Logger.h"

#include <QApplication>
#include <QCheckBox>
#include <QDialog>
#include <QFile>
#include <QFrame>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QMouseEvent>
#include <QWindow>
#ifdef WORKSUITE_QPA_FOCUS
#include <qpa/qwindowsysteminterface.h>
#endif
#include <QProcess>
#include <QRegularExpression>
#include <QSet>
#include <QSettings>
#include <QStorageInfo>
#include <QToolBar>
#include <QTimer>
#include <QVBoxLayout>

CALAMARES_PLUGIN_FACTORY_DEFINITION( WorksuiteConfirmViewStepFactory, registerPlugin< WorksuiteConfirmViewStep >(); )

static const char RECOVERY_KEY[] = "worksuiteRecoveryKey";
// Read by the slideshow (show.qml) and the sidebar: whether the install encrypts the disk.
static const char ENCRYPTED_KEY[] = "worksuiteEncrypted";
// branding/worksuite/WsState.qml: the file the QML pages share their state through.
static const char WS_STATE[] = "/run/worksuite-installer.conf";

static void
recordEncryption( bool on )
{
    if ( auto* jq = Calamares::JobQueue::instance() )
    {
        jq->globalStorage()->insert( QString::fromLatin1( ENCRYPTED_KEY ), on );
    }
    QSettings state( QString::fromLatin1( WS_STATE ), QSettings::IniFormat );
    state.setValue( QStringLiteral( "encrypt" ), on );
    state.sync();
}

/* The install page (branding/worksuite/show.qml) shows real numbers only. Calamares passes the slideshow nothing,
   so the queue's progress signal is copied into global storage, which the page polls:
     worksuiteProgress    0..1, the whole queue (the same value as Calamares' own bar)
     worksuiteLog         the job status lines so far ("Show details")
     worksuiteFiles*      unpackfs "Unpacking image a/b, file n/m"
     worksuitePackages*   packages "Processing packages (n / m)"
     worksuiteBytesDone   bytes written to the target root since the copy started (its file system's used space)
     worksuiteBytesTotal  the image's unpacked size, measured at image build time (/usr/share/worksuite/rootfs.size) */
static void
reportProgress( qreal percent, const QString& message )
{
    auto* jq = Calamares::JobQueue::instance();
    if ( !jq )
    {
        return;
    }
    auto* gs = jq->globalStorage();
    gs->insert( QStringLiteral( "worksuiteProgress" ), percent );

    static QStringList log;
    const QString line = message.trimmed();
    if ( !line.isEmpty() && ( log.isEmpty() || log.last() != line ) )
    {
        log << line;
        while ( log.size() > 200 )
        {
            log.removeFirst();
        }
        gs->insert( QStringLiteral( "worksuiteLog" ), log );
    }

    static const QRegularExpression files( QStringLiteral( "(\\d+)\\s*/\\s*(\\d+)\\s*$" ) );
    static const QRegularExpression packages( QStringLiteral( "\\((\\d+)\\s*/\\s*(\\d+)\\)" ) );
    const QString phase = gs->value( QStringLiteral( "worksuitePhase" ) ).toString();
    if ( phase == QLatin1String( "copy" ) )
    {
        const auto m = files.match( line );
        if ( m.hasMatch() && m.captured( 2 ).toLongLong() > 0 )
        {
            gs->insert( QStringLiteral( "worksuiteFilesDone" ), m.captured( 1 ).toLongLong() );
            gs->insert( QStringLiteral( "worksuiteFilesTotal" ), m.captured( 2 ).toLongLong() );
        }
    }
    const auto pm = packages.match( line );
    if ( pm.hasMatch() && pm.captured( 2 ).toLongLong() > 0 )
    {
        gs->insert( QStringLiteral( "worksuitePackagesDone" ), pm.captured( 1 ).toLongLong() );
        gs->insert( QStringLiteral( "worksuitePackagesTotal" ), pm.captured( 2 ).toLongLong() );
    }

    static qint64 total = -1;
    if ( total < 0 )
    {
        QFile f( QStringLiteral( "/usr/share/worksuite/rootfs.size" ) );
        total = f.open( QIODevice::ReadOnly ) ? QString::fromLatin1( f.readAll() ).trimmed().section( QLatin1Char( '\t' ), 0, 0 ).toLongLong() : 0;
        if ( total > 0 )
        {
            gs->insert( QStringLiteral( "worksuiteBytesTotal" ), total );
        }
    }
    const QString root = gs->value( QStringLiteral( "rootMountPoint" ) ).toString();
    if ( ( phase == QLatin1String( "prepare" ) || phase == QLatin1String( "copy" ) ) && !root.isEmpty() && root != QLatin1String( "/" ) )
    {
        QStorageInfo target( root );
        if ( target.isValid() && target.rootPath() == root )
        {
            static qint64 baseline = -1;   // the empty file system's own use (journal, metadata)
            const qint64 used = target.bytesTotal() - target.bytesFree();
            if ( baseline < 0 )
            {
                baseline = used;
            }
            gs->insert( QStringLiteral( "worksuiteBytesDone" ), qMax< qint64 >( 0, used - baseline ) );
        }
    }
}

namespace
{
/* Calamares (Qt 6) shows each QML page as a QQuickWindow embedded in the page's widget through a window container,
   and focuses the page widget, not the container. Keystrokes then stop at the page widget and the WorkSuite QML
   pages' text fields never get them; a click into the embedded window does not move focus either. This filter
   gives the container focus when its page widget gets it (or when the container arrives after, once the QML has
   loaded), and when the embedded window is clicked. Classes are matched by name: no extra Qt link. */
class QmlFocus : public QObject
{
public:
    using QObject::QObject;

    static QWidget* qmlChild( QWidget* w )
    {
        for ( auto* child : w->findChildren< QWidget* >( QString(), Qt::FindDirectChildrenOnly ) )
        {
            if ( ( child->inherits( "QWindowContainer" ) || child->inherits( "QQuickWidget" ) ) && child->isVisible() )
            {
                return child;
            }
        }
        return nullptr;
    }

    // The QML window a window container shows: the visible Qt Quick window at the container's position.
    static QWindow* embeddedWindow( QWidget* container )
    {
        const QPoint at = container->mapToGlobal( QPoint( 0, 0 ) );
        for ( auto* win : QGuiApplication::allWindows() )
        {
            if ( win->inherits( "QQuickWindow" ) && win->isVisible() && win->parent() && win->mapToGlobal( QPoint( 0, 0 ) ) == at )
            {
                return win;
            }
        }
        return nullptr;
    }

    // Qt Quick gives an item active focus only while its window is the application's focus window
    // (QQuickDeliveryAgent: windowHasFocus), and on Wayland an embedded window never becomes it. Make it so, as the
    // X11 and Windows platforms do when an embedded window is clicked.
    static void focusWindow( QWindow* win )
    {
#ifdef WORKSUITE_QPA_FOCUS
        if ( QGuiApplication::focusWindow() != win )
        {
            QWindowSystemInterface::handleFocusWindowChanged( win, Qt::OtherFocusReason );
            QWindowSystemInterface::flushWindowSystemEvents();
        }
#else
        Q_UNUSED( win )
#endif
    }

    bool eventFilter( QObject* o, QEvent* e ) override
    {
        // On Wayland a focused window container does not pass keys on to its window: forward them.
        if ( o->isWidgetType() && ( e->type() == QEvent::KeyPress || e->type() == QEvent::KeyRelease ) )
        {
            auto* w = static_cast< QWidget* >( o );
            QWidget* container = w->inherits( "QWindowContainer" ) ? w : nullptr;
            if ( !container )
            {
                auto* q = qmlChild( w );
                container = q && q->inherits( "QWindowContainer" ) ? q : nullptr;
            }
            if ( container && !m_forwarding )
            {
                if ( auto* win = embeddedWindow( container ) )
                {
                    m_forwarding = true;
                    focusWindow( win );
                    QCoreApplication::sendEvent( win, e );
                    m_forwarding = false;
                    return true;
                }
            }
        }
        // Stock Calamares widgets restyled toward the design (WsStyle.cpp): the partition page and dialogs.
        if ( o->isWidgetType() )
        {
            auto* w = static_cast< QWidget* >( o );
            if ( e->type() == QEvent::Polish && w->isWindow() )
            {
                WsStyle::prepareDialog( w );
            }
            else if ( e->type() == QEvent::Show )
            {
                if ( w->objectName() == QLatin1String( "ChoicePage" ) )
                {
                    WsStyle::styleChoicePage( w );
                }
                else if ( w->isWindow() )
                {
                    WsStyle::styleDialog( w );
                }
            }
            else if ( e->type() == QEvent::Hide && w->isWindow() )
            {
                WsStyle::dialogHidden( w );
            }
        }
        // The install page draws its own progress card (show.qml): hide Calamares' bar, log button and status line.
        if ( o->isWidgetType() && e->type() == QEvent::Show && o->objectName() == QLatin1String( "exec-progress" ) )
        {
            auto* bar = static_cast< QWidget* >( o );
            QTimer::singleShot( 0, bar, [ bar ] {
                bar->hide();
                if ( auto* page = bar->parentWidget() )
                {
                    for ( auto* tb : page->findChildren< QToolBar* >( QString(), Qt::FindDirectChildrenOnly ) )
                    {
                        tb->hide();
                    }
                    if ( auto* label = page->findChild< QWidget* >( QStringLiteral( "exec-message" ) ) )
                    {
                        label->hide();
                    }
                }
            } );
        }
        // The stock partition page's "Encrypt system" box: report its state to the sidebar and slideshow.
        if ( o->isWidgetType() && e->type() == QEvent::Show && o->objectName() == QLatin1String( "m_encryptCheckBox" )
             && !o->property( "wsWatched" ).toBool() )
        {
            if ( auto* box = qobject_cast< QCheckBox* >( o ) )
            {
                box->setProperty( "wsWatched", true );
                recordEncryption( box->isChecked() );
                QObject::connect( box, &QCheckBox::toggled, box, []( bool on ) { recordEncryption( on ); } );
            }
        }
        if ( o->isWidgetType() )
        {
            auto* w = static_cast< QWidget* >( o );
            if ( e->type() == QEvent::FocusIn || ( e->type() == QEvent::KeyPress && w->hasFocus() ) )
            {
                if ( auto* q = qmlChild( w ) )
                {
                    q->setFocus( Qt::OtherFocusReason );
                }
            }
            else if ( e->type() == QEvent::ChildPolished && w->hasFocus() )
            {
                if ( auto* q = qmlChild( w ) )
                {
                    q->setFocus( Qt::OtherFocusReason );
                }
            }
        }
        else if ( o->isWindowType() && e->type() == QEvent::MouseButtonPress )
        {
            auto* win = static_cast< QWindow* >( o );
            if ( win->inherits( "QQuickWindow" ) && win->parent() )
            {
                focusWindow( win );   // before the press, so the field under it can take focus
            }
            // A click in an embedded QML window: focus the container showing it.
            const QPoint at = static_cast< QMouseEvent* >( e )->globalPosition().toPoint();
            for ( auto* w : QApplication::allWidgets() )
            {
                if ( w->inherits( "QWindowContainer" ) && w->isVisible() && !w->hasFocus()
                     && QRect( w->mapToGlobal( QPoint( 0, 0 ) ), w->size() ).contains( at ) )
                {
                    w->setFocus( Qt::MouseFocusReason );
                    break;
                }
            }
        }
        return false;
    }

private:
    bool m_forwarding = false;
};
}  // namespace

/* Calamares applies the branding stylesheet to its main window only, so its error and confirmation dialogs (top-level
   windows) kept the light default style. Give the application the stylesheet's dialog rules (QDialog, QMessageBox),
   and its button rules scoped to dialogs. */
QString
WorksuiteConfirmViewStep::dialogStyleSheet( const QString& sheet )
{
    QString out;
    static const QRegularExpression rule( QStringLiteral( "([^{}]+)\\{([^{}]*)\\}" ) );
    QString text = sheet;
    text.remove( QRegularExpression( QStringLiteral( "/\\*.*?\\*/" ), QRegularExpression::DotMatchesEverythingOption ) );
    auto it = rule.globalMatch( text );
    while ( it.hasNext() )
    {
        const auto m = it.next();
        const QString selectors = m.captured( 1 ).trimmed();
        const QString body = m.captured( 2 ).trimmed();
        if ( selectors.contains( QStringLiteral( "QDialog" ) ) || selectors.contains( QStringLiteral( "QMessageBox" ) ) )
        {
            out += selectors + QStringLiteral( " { " ) + body + QStringLiteral( " }\n" );
        }
        else if ( selectors.startsWith( QStringLiteral( "QPushButton" ) ) )
        {
            QStringList scoped;
            for ( const QString& sel : selectors.split( ',' ) )
            {
                scoped << QStringLiteral( "QDialog " ) + sel.trimmed();
            }
            out += scoped.join( QStringLiteral( ", " ) ) + QStringLiteral( " { " ) + body + QStringLiteral( " }\n" );
        }
    }
    return out;
}

WorksuiteConfirmViewStep::WorksuiteConfirmViewStep( QObject* parent )
    : Calamares::ViewStep( parent )
{
    // Both instances load at startup; one filter for the application is enough.
    static QmlFocus* focus = nullptr;
    if ( !focus && qApp )
    {
        focus = new QmlFocus( qApp );
        qApp->installEventFilter( focus );
        if ( auto* branding = Calamares::Branding::instance() )
        {
            const QString dialogs = dialogStyleSheet( branding->stylesheet() );
            if ( !dialogs.isEmpty() )
            {
                qApp->setStyleSheet( qApp->styleSheet() + dialogs );
            }
        }
        recordEncryption( false );
        {
            QSettings state( QString::fromLatin1( WS_STATE ), QSettings::IniFormat );
            state.setValue( QStringLiteral( "installFailed" ), false );
        }
        /* On a failed install Calamares shows an error dialog that quits the whole program when it closes, so the
           finishedq failure page (what failed, the details, what helps) behind it was never seen. The queue moves on
           to that page by itself; keep Calamares running when the dialog closes. ViewManager's handler runs first
           (it connected before any module loaded), so the dialog exists by the time this one runs. */
        if ( auto* jq = Calamares::JobQueue::instance() )
        {
            QObject::connect( jq, &Calamares::JobQueue::progress, qApp, &reportProgress );
            QObject::connect( jq, &Calamares::JobQueue::failed, qApp, [] {
                QSettings state( QString::fromLatin1( WS_STATE ), QSettings::IniFormat );
                state.setValue( QStringLiteral( "installFailed" ), true );   // the footer keeps Quit usable
                state.sync();
                QTimer::singleShot( 0, qApp, [] {
                    for ( auto* w : QApplication::topLevelWidgets() )
                    {
                        auto* dlg = qobject_cast< QDialog* >( w );
                        if ( dlg && dlg->inherits( "Calamares::ErrorDialog" ) && !dlg->property( "wsKept" ).toBool() )
                        {
                            dlg->setProperty( "wsKept", true );
                            QObject::disconnect( dlg, &QDialog::finished, nullptr, nullptr );
                            QObject::connect( dlg, &QDialog::finished, dlg, &QObject::deleteLater );
                            cDebug() << "WorkSuite: the error dialog now closes to the failure page instead of quitting.";
                        }
                    }
                } );
            } );
        }
    }
}

WorksuiteConfirmViewStep::~WorksuiteConfirmViewStep()
{
    if ( m_widget && !m_widget->parent() )
    {
        delete m_widget;
    }
}

QString
WorksuiteConfirmViewStep::prettyName() const
{
    return m_mode == Mode::Erase ? tr( "Confirm erase" ) : tr( "Recovery key" );
}

void
WorksuiteConfirmViewStep::setConfigurationMap( const QVariantMap& map )
{
    m_mode = map.value( QStringLiteral( "mode" ) ).toString() == QStringLiteral( "recovery" ) ? Mode::Recovery : Mode::Erase;
}

QString
WorksuiteConfirmViewStep::diskFromDescriptions( const QStringList& descriptions )
{
    static const QRegularExpression node( QStringLiteral( "/dev/(nvme\\d+n\\d+|mmcblk\\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+)(?![a-z0-9])" ) );
    QSet< QString > disks;
    for ( const QString& d : descriptions )
    {
        auto it = node.globalMatch( d );
        while ( it.hasNext() )
        {
            disks.insert( it.next().captured( 1 ) );
        }
    }
    // A single target disk only: anything else is not a whole-disk install this step can confirm.
    return disks.size() == 1 ? *disks.begin() : QString();
}

bool
WorksuiteConfirmViewStep::confirmationMatches( const QString& typed, const QString& disk )
{
    QString t = typed.trimmed();
    if ( t.startsWith( QStringLiteral( "/dev/" ) ) )
    {
        t = t.mid( 5 );
    }
    return !disk.isEmpty() && t == disk;
}

void
WorksuiteConfirmViewStep::parseLsblk( const QString& out, QString& model, QString& size )
{
    static const QRegularExpression pair( QStringLiteral( "(MODEL|SIZE)=\"([^\"]*)\"" ) );
    model.clear();
    size.clear();
    auto it = pair.globalMatch( out );
    while ( it.hasNext() )
    {
        const auto m = it.next();
        ( m.captured( 1 ) == QLatin1String( "MODEL" ) ? model : size ) = m.captured( 2 ).simplified();
    }
}

QString
WorksuiteConfirmViewStep::diskTitle( const QString& disk, const QString& model, const QString& size )
{
    if ( disk.isEmpty() )
    {
        return tr( "Unknown disk" );
    }
    const QString m = model.trimmed(), s = size.trimmed();
    if ( m.isEmpty() )
    {
        return s.isEmpty() ? disk : QStringLiteral( "%1 · %2" ).arg( disk, s );
    }
    return s.isEmpty() ? QStringLiteral( "%1 (%2)" ).arg( m, disk ) : QStringLiteral( "%1 · %2 (%3)" ).arg( m, s, disk );
}

QString
WorksuiteConfirmViewStep::opKind( const QString& description )
{
    const QString lower = description.toLower();
    if ( lower.contains( QStringLiteral( "clear mounts" ) ) || lower.contains( QStringLiteral( "clear all temporary mounts" ) ) )
    {
        return QString();
    }
    if ( lower.contains( QStringLiteral( "format" ) ) )
    {
        return QStringLiteral( "FORMAT" );
    }
    if ( lower.contains( QStringLiteral( "delete" ) ) || lower.contains( QStringLiteral( "remove" ) ) )
    {
        return QStringLiteral( "DELETE" );
    }
    if ( lower.contains( QStringLiteral( "create" ) ) )
    {
        return QStringLiteral( "CREATE" );
    }
    return QStringLiteral( "OTHER" );
}

bool
WorksuiteConfirmViewStep::encryptedFromDescriptions( const QStringList& descriptions )
{
    for ( const QString& d : descriptions )
    {
        const QString lower = d.toLower();
        if ( lower.contains( QStringLiteral( "luks" ) ) || lower.contains( QStringLiteral( "encrypt" ) ) )
        {
            return true;
        }
    }
    return false;
}

// Layout of the design's "5 · Confirm disk" and "6 · Recovery key" screens; branding/worksuite/stylesheet.qss
// styles the parts by object name (#wsConfirm …).
static QLabel*
label( const QString& name, QWidget* parent = nullptr )
{
    auto* l = new QLabel( parent );
    l->setObjectName( name );
    l->setWordWrap( true );
    return l;
}

QWidget*
WorksuiteConfirmViewStep::widget()
{
    if ( m_widget )
    {
        return m_widget;
    }
    m_widget = new QWidget;
    m_widget->setObjectName( m_mode == Mode::Erase ? QStringLiteral( "wsConfirm" ) : QStringLiteral( "wsRecovery" ) );
    m_widget->setAttribute( Qt::WA_StyledBackground );
    // Calamares strips the margins of a page's own layout, so the content sits in an inner widget with them.
    auto* outer = new QVBoxLayout( m_widget );
    auto* inner = new QWidget;
    inner->setObjectName( QStringLiteral( "wsPageBody" ) );
    outer->addWidget( inner );
    auto* layout = new QVBoxLayout( inner );
    layout->setContentsMargins( 56, 40, 56, 24 );
    layout->setSpacing( 22 );

    auto* head = new QVBoxLayout;
    head->setSpacing( 6 );
    m_eyebrow = label( QStringLiteral( "wsEyebrow" ) );
    m_title = label( QStringLiteral( "wsTitle" ) );
    m_details = label( QStringLiteral( "wsSubtitle" ) );
    m_details->setTextFormat( Qt::PlainText );
    head->addWidget( m_eyebrow );
    head->addWidget( m_title );
    head->addWidget( m_details );
    layout->addLayout( head );

    if ( m_mode == Mode::Erase )
    {
        // Disk card: name and node, then one row per planned change.
        auto* card = new QFrame;
        card->setObjectName( QStringLiteral( "wsDiskCard" ) );
        auto* cardLayout = new QVBoxLayout( card );
        cardLayout->setContentsMargins( 0, 0, 0, 8 );
        cardLayout->setSpacing( 0 );
        auto* header = new QFrame;
        header->setObjectName( QStringLiteral( "wsDiskHeader" ) );
        auto* headerLayout = new QHBoxLayout( header );
        headerLayout->setContentsMargins( 20, 16, 20, 16 );
        m_diskName = label( QStringLiteral( "wsDiskName" ) );
        m_diskNode = label( QStringLiteral( "wsDiskNode" ) );
        m_diskNode->setWordWrap( false );
        headerLayout->addWidget( m_diskName, 1 );
        headerLayout->addWidget( m_diskNode );
        cardLayout->addWidget( header );
        m_ops = new QVBoxLayout;
        m_ops->setContentsMargins( 20, 8, 20, 0 );
        m_ops->setSpacing( 4 );
        cardLayout->addLayout( m_ops );
        layout->addWidget( card );

        m_inputLabel = label( QStringLiteral( "wsFieldLabel" ) );
        m_input = new QLineEdit;
        m_input->setObjectName( QStringLiteral( "wsConfirmInput" ) );
        m_input->setAccessibleName( tr( "Type the disk name to confirm" ) );
        layout->addWidget( m_inputLabel );
        layout->addWidget( m_input );
        connect( m_input, &QLineEdit::textChanged, this, [ this ] { refresh(); } );
    }
    else
    {
        m_keyBox = new QFrame;
        m_keyBox->setObjectName( QStringLiteral( "wsKeyBox" ) );
        m_keyGrid = new QGridLayout( m_keyBox );
        m_keyGrid->setContentsMargins( 24, 24, 24, 24 );
        m_keyGrid->setSpacing( 12 );
        layout->addWidget( m_keyBox );
        m_key = label( QStringLiteral( "wsKeyPlain" ) );   // the whole key, selectable, for screen readers and copying
        m_key->setTextInteractionFlags( Qt::TextSelectableByMouse );
        layout->addWidget( m_key );
        m_saved = new QCheckBox( tr( "I've saved my recovery key somewhere safe" ) );
        m_saved->setObjectName( QStringLiteral( "wsAck" ) );
        layout->addWidget( m_saved );
        connect( m_saved, &QCheckBox::toggled, this, [ this ] { refresh(); } );
    }
    layout->addStretch();
    return m_widget;
}

// One row of the disk card: a tag (DELETE / CREATE / FORMAT) and what the partition step will do.
static QWidget*
opRow( const QString& kind, const QString& tag, const QString& text )
{
    auto* row = new QWidget;
    auto* l = new QHBoxLayout( row );
    l->setContentsMargins( 0, 6, 0, 6 );
    l->setSpacing( 14 );
    auto* t = label( QStringLiteral( "wsTag" ) );
    t->setProperty( "kind", kind );
    t->setText( tag );
    t->setAlignment( Qt::AlignCenter );
    t->setFixedWidth( 64 );
    t->setWordWrap( false );
    auto* d = label( QStringLiteral( "wsOp" ) );
    d->setTextFormat( Qt::PlainText );
    d->setText( text );
    l->addWidget( t, 0, Qt::AlignTop );
    l->addWidget( d, 1 );
    return row;
}

void
WorksuiteConfirmViewStep::onActivate()
{
    widget();
    if ( m_mode == Mode::Erase )
    {
        // The partition step's planned jobs are what the summary page lists; take the target disk from them.
        QStringList descriptions, changes;
        for ( auto* step : Calamares::ViewManager::instance()->viewSteps() )
        {
            if ( step == this )
            {
                break;
            }
            for ( const auto& job : step->jobs() )
            {
                descriptions << job->prettyName() << job->prettyDescription();
                if ( job->prettyName().contains( QStringLiteral( "/dev/" ) ) )
                {
                    changes << job->prettyName();   // the partition step's changes, not users, locale, …
                }
            }
        }
        m_disk = diskFromDescriptions( descriptions );
        // Calamares describes an encrypted root as "... with entries root", without saying luks: the descriptions
        // can only confirm encryption, never rule it out. The Encrypt box (watched above) records the off state.
        if ( encryptedFromDescriptions( descriptions ) )
        {
            recordEncryption( true );
        }
        QString model, size;
        if ( !m_disk.isEmpty() )
        {
            QProcess p;
            p.start( QStringLiteral( "lsblk" ), { QStringLiteral( "-dnPo" ), QStringLiteral( "MODEL,SIZE" ), QStringLiteral( "/dev/" ) + m_disk } );
            p.waitForFinished( 5000 );
            parseLsblk( QString::fromUtf8( p.readAllStandardOutput() ), model, size );
        }
        m_eyebrow->setText( tr( "STEP 5 · CONFIRM DISK" ) );
        m_title->setText( tr( "This will erase your disk" ) );
        m_details->setText( m_disk.isEmpty()
                                ? tr( "The target disk could not be identified. Go back and choose the disk again." )
                                : tr( "After you press Install, these changes can't be undone." ) );
        m_diskName->setText( diskTitle( m_disk, model, size ) );
        m_diskNode->setText( m_disk.isEmpty() ? QString() : QStringLiteral( "/dev/" ) + m_disk );
        while ( auto* item = m_ops->takeAt( 0 ) )
        {
            delete item->widget();
            delete item;
        }
        m_ops->addWidget( opRow( QStringLiteral( "DELETE" ), tr( "DELETE" ), tr( "Existing partition table and all data" ) ) );
        for ( const QString& c : changes )
        {
            const QString text = QString( c ).remove( QRegularExpression( QStringLiteral( "<[^>]*>" ) ) );
            const QString kind = opKind( text );
            if ( kind.isEmpty() )
            {
                continue;   // housekeeping (clearing mounts), not a change to the disk
            }
            const QString tag = kind == QLatin1String( "FORMAT" ) ? tr( "FORMAT" )
                : kind == QLatin1String( "DELETE" )                ? tr( "DELETE" )
                : kind == QLatin1String( "CREATE" )                ? tr( "CREATE" )
                                                                   : tr( "SET" );
            m_ops->addWidget( opRow( kind, tag, text ) );
        }
        m_inputLabel->setText( tr( "Type %1 to confirm that all data on it will be permanently deleted" ).arg( m_disk ) );
        m_input->clear();
        m_input->setEnabled( !m_disk.isEmpty() );
        m_input->setFocus();
    }
    else
    {
        const QString key = Calamares::JobQueue::instance()->globalStorage()->value( QString::fromLatin1( RECOVERY_KEY ) ).toString();
        m_eyebrow->setText( tr( "STEP 6 · RECOVERY KEY" ) );
        m_title->setText( tr( "Save your recovery key" ) );
        m_details->setText( tr( "If you forget your disk passphrase, this key is the only way to unlock your files. "
                                "It is shown once and is not stored on this computer." ) );
        m_key->setText( key );
        // The key's groups in a four-column grid, as in the design.
        while ( auto* item = m_keyGrid->takeAt( 0 ) )
        {
            delete item->widget();
            delete item;
        }
        const QStringList groups = key.split( QLatin1Char( '-' ), Qt::SkipEmptyParts );
        for ( int i = 0; i < groups.size(); ++i )
        {
            auto* g = label( QStringLiteral( "wsKeyGroup" ) );
            g->setWordWrap( false );
            g->setAlignment( Qt::AlignCenter );
            g->setText( groups.at( i ) );
            m_keyGrid->addWidget( g, i / 4, i % 4 );
        }
        m_saved->setChecked( false );
        if ( key.isEmpty() )
        {
            // Unencrypted install: nothing to show.
            m_ok = true;
            emit nextStatusChanged( true );
            Calamares::ViewManager::instance()->next();
            return;
        }
    }
    refresh();
}

void
WorksuiteConfirmViewStep::onLeave()
{
    if ( m_mode == Mode::Recovery && m_ok )
    {
        // Shown once: drop it from memory as soon as the user moves on.
        Calamares::JobQueue::instance()->globalStorage()->remove( QString::fromLatin1( RECOVERY_KEY ) );
        if ( m_key )
        {
            m_key->clear();
        }
    }
}

void
WorksuiteConfirmViewStep::refresh()
{
    const bool ok = m_mode == Mode::Erase ? confirmationMatches( m_input->text(), m_disk ) : m_saved->isChecked();
    if ( ok != m_ok )
    {
        m_ok = ok;
        emit nextStatusChanged( ok );
    }
}

bool
WorksuiteConfirmViewStep::isNextEnabled() const
{
    return m_ok;
}

bool
WorksuiteConfirmViewStep::isBackEnabled() const
{
    // The recovery step comes after installation: there is nothing to go back to.
    return m_mode == Mode::Erase;
}

bool
WorksuiteConfirmViewStep::isAtBeginning() const
{
    return true;
}

bool
WorksuiteConfirmViewStep::isAtEnd() const
{
    return true;
}

Calamares::JobList
WorksuiteConfirmViewStep::jobs() const
{
    return {};
}
