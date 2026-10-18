/* The installer's loading screen, continued inside Calamares (see WsIntro.h). */
#include "WsIntro.h"

#include <QApplication>
#include <QCoreApplication>
#include <QEvent>
#include <QFont>
#include <QLinearGradient>
#include <QPainter>
#include <QPixmap>
#include <QPointer>
#include <QQuickWidget>
#include <QQuickItem>
#include <QScreen>
#include <QQuickWindow>
#include <QWindow>
#include <QSizePolicy>
#include <QTimer>
#include <QWidget>

#include <cmath>
#include <ctime>

namespace
{
// extract.py collects the tr() strings of this file under the context "WsIntro".
QString
tr( const char* s )
{
    return QCoreApplication::translate( "WsIntro", s );
}

// The same motion as the veil (services/session/greeter/worksuite_greeter/veil.py; test_veil.py compares them).
constexpr double BREATH_S = 2.4;
constexpr double SHIMMER_S = 1.6;
constexpr double SHIMMER_W = 140;
constexpr double SPIN_S = 1.4;
constexpr int HOLD_MS = 900;    // the window's first page settles under the curtain
constexpr int FADE_MS = 700;    // the cross-fade into it
constexpr int CONTENT_MS = 350; // then a QML page in a window of its own fades in over its background
const QColor BG( 4, 10, 26 );   // #040A1A, the splash background
const QColor SIDEBAR( 7, 19, 48 );   // #071330, the sidebar (the mark's notch there)
const QColor PAGE( 10, 26, 61 );     // #0A1A3D, the main window behind the pages
const QColor BLUE( 31, 107, 255 ), CYAN( 24, 212, 240 );

qint64
monotonicUs()
{
    timespec ts {};
    clock_gettime( CLOCK_MONOTONIC, &ts );   // GLib's g_get_monotonic_time() clock
    return qint64( ts.tv_sec ) * 1000000 + ts.tv_nsec / 1000;
}

double
easeInOut( double p )
{
    p = qBound( 0.0, p, 1.0 );
    return p < 0.5 ? 4 * p * p * p : 1 - std::pow( -2 * p + 2, 3 ) / 2;
}

QColor
mix( const QColor& a, const QColor& b, double p )
{
    return QColor::fromRgbF( a.redF() + ( b.redF() - a.redF() ) * p, a.greenF() + ( b.greenF() - a.greenF() ) * p,
                             a.blueF() + ( b.blueF() - a.blueF() ) * p );
}

class Curtain : public QWidget
{
public:
    Curtain( QWidget* win, const WsIntro::Options& o )
        : QWidget( win )
        , m_o( o )
        , m_win( win )
    {
        setObjectName( QStringLiteral( "wsIntro" ) );
        setAttribute( Qt::WA_OpaquePaintEvent );
        setGeometry( win->rect() );
        win->installEventFilter( this );
        qApp->installEventFilter( this );   // pages shown later (the first page's QML) stay under the curtain
        hidePages();
        show();
        raise();
        connect( &m_tick, &QTimer::timeout, this, [ this ] { tick(); } );
        m_tick.start( 16 );
        m_shown = win->isVisible() ? monotonicUs() : 0;   // the hold starts when the window is on screen
    }

protected:
    bool eventFilter( QObject* o, QEvent* e ) override
    {
        if ( !m_fading && ( ( e->type() == QEvent::Show && o->isWidgetType() && o->inherits( "QQuickWidget" ) )
                            || ( e->type() == QEvent::Expose && o->isWindowType() && static_cast< QWindow* >( o )->parent() ) ) )
        {
            hidePages();
        }
        if ( o == m_win && e->type() == QEvent::Show && !m_shown )
        {
            m_shown = monotonicUs();
            setGeometry( m_win->rect() );
            hidePages();
            raise();
        }
        if ( o == m_win && e->type() == QEvent::Resize )
        {
            setGeometry( m_win->rect() );
            m_snap = QPixmap();
        }
        else if ( o == m_win && e->type() == QEvent::ChildAdded && !m_fading )
        {
            QTimer::singleShot( 0, this, [ this ] {
                hidePages();
                raise();
            } );
        }
        return false;
    }

    void paintEvent( QPaintEvent* ) override
    {
        QPainter p( this );
        p.setRenderHint( QPainter::Antialiasing );
        const double t = m_o.reducedMotion ? 0 : qMax( 0.0, ( monotonicUs() - m_o.t0Us ) / 1e6 );
        const double f = m_fading ? easeInOut( ( monotonicUs() - m_fadeStart ) / 1000.0 / FADE_MS ) : 0;
        p.fillRect( rect(), BG );
        if ( !m_snap.isNull() )
        {
            p.setOpacity( f );
            p.drawPixmap( rect(), m_snap );
            p.setOpacity( 1 );
        }
        // The splash's column (veil.column): ring top at the middle - 136, title 148 below, bar 243 below.
        // Centred on the screen, where the veil has it: cage shows a window at the output's corner, and for a moment after
        // it shows the main window still has its own size, before cage makes it fill the screen.
        const QSize screen = m_win->screen() ? m_win->screen()->size() : size();
        const double cx = screen.width() / 2.0, ringY = std::floor( screen.height() / 2.0 - 273 / 2.0 );
        const double column = qMax( 0.0, 1 - f * 1.8 );   // texts, ring and bar go first
        if ( column > 0 )
        {
            p.setOpacity( column );
            const QPointF rc( cx, ringY + 60 );
            p.setPen( QPen( QColor( 127, 178, 255, 31 ), 4 ) );
            p.drawEllipse( rc, 54, 54 );
            p.setPen( QPen( CYAN, 4, Qt::SolidLine, Qt::RoundCap ) );
            const double turn = t / SPIN_S * 360;   // the veil's arc: from 12 o'clock + angle, a quarter
            p.drawArc( QRectF( rc.x() - 54, rc.y() - 54, 108, 108 ), int( ( 90 - turn ) * 16 ), -90 * 16 );
            QFont title( QStringLiteral( "IBM Plex Sans" ) );
            title.setPixelSize( 28 );
            title.setWeight( QFont::Medium );
            p.setFont( title );
            p.setPen( QColor( 232, 238, 250 ) );
            p.drawText( QRectF( 0, ringY + 148, width(), 40 ), Qt::AlignHCenter | Qt::AlignTop, m_o.title );
            const double tx = cx - 210, ty = ringY + 243;
            p.fillRect( QRectF( tx, ty, 420, 4 ), QColor( 127, 178, 255, 31 ) );
            if ( m_o.reducedMotion )
            {
                QLinearGradient g( tx, 0, tx + 420, 0 );
                g.setColorAt( 0, BLUE );
                g.setColorAt( 1, CYAN );
                p.fillRect( QRectF( tx, ty, 420, 4 ), g );
            }
            else
            {
                const double x0 = tx + std::fmod( t, SHIMMER_S ) / SHIMMER_S * ( 420 + SHIMMER_W ) - SHIMMER_W;
                QLinearGradient g( x0, 0, x0 + SHIMMER_W, 0 );
                g.setColorAt( 0, QColor( 31, 107, 255, 0 ) );
                g.setColorAt( 0.5, CYAN );
                g.setColorAt( 1, QColor( 31, 107, 255, 0 ) );
                const double l = qMax( tx, x0 ), r = qMin( tx + 420, x0 + SHIMMER_W );
                if ( r > l )
                {
                    p.fillRect( QRectF( l, ty, r - l, 4 ), g );
                }
            }
            QFont mono( QStringLiteral( "IBM Plex Mono" ) );
            mono.setPixelSize( 12 );
            p.setFont( mono );
            p.setPen( QColor( 94, 115, 156 ) );
            p.drawText( QRectF( tx, ty + 14, 420, 20 ), Qt::AlignRight | Qt::AlignTop, m_o.version );
            p.setOpacity( 1 );
        }
        // The mark: breathing at the middle; in the fade it glides into the sidebar's logo (calamares-sidebar.qml:
        // 28 px at 20, 32). Reduced motion: it fades with the rest.
        const double s = 0.5 - 0.5 * std::cos( 2 * M_PI * t / BREATH_S );
        double alpha = 1 - 0.22 * s, size = 48 * ( 1 + 0.04 * s );
        QPointF centre( cx, ringY + 60 );
        QColor notch = BG;
        if ( m_fading )
        {
            if ( m_o.reducedMotion )
            {
                alpha = 1 - f;
            }
            else
            {
                const QPointF to( 20 + 14, 32 + 14 );
                centre = centre + ( to - centre ) * f;
                size = size + ( 28 - size ) * f;
                alpha = alpha + ( 1 - alpha ) * f;
                notch = mix( BG, SIDEBAR, f );
            }
        }
        const double k = size / 60;
        const QPointF m = centre - QPointF( 30 * k, 30 * k );
        auto sq = [ & ]( double x, double y, double w, const QColor& c, bool round ) {
            QColor col = c;
            col.setAlphaF( col.alphaF() * alpha );
            p.setPen( Qt::NoPen );
            p.setBrush( col );
            const QRectF r( m.x() + x * k, m.y() + y * k, w * k, w * k );
            round ? p.drawRoundedRect( r, 3 * k, 3 * k ) : p.drawRect( r );
        };
        sq( 20, 0, 40, BLUE, true );
        sq( 20, 20, 20, notch, false );
        sq( 0, 20, 20, CYAN, true );
        sq( 20, 40, 20, CYAN, true );
    }

public:
    void keepOffScreen( const QList< QPointer< QWidget > >& widgets ) { m_offScreen = widgets; }

private:
    void tick()
    {
        const qint64 now = monotonicUs();
        if ( !m_fading && m_shown && now - m_shown >= qint64( HOLD_MS ) * 1000 )
        {
            startFade();
        }
        if ( m_fading && !m_returned && now - m_fadeStart >= qint64( FADE_MS ) * 1000 )
        {
            m_returned = now;
            showPages();
        }
        if ( m_returned )
        {
            // A page in a window of its own can't be captured while it is unmapped (rendering it offscreen left it
            // blank for good), so it was left out of the cross-fade: it comes back with its background only (the
            // colour the window showed there) and its content fades in.
            const double c = easeInOut( ( now - m_returned ) / 1000.0 / CONTENT_MS );
            for ( const auto& item : std::as_const( m_contents ) )
            {
                if ( item )
                {
                    item->setOpacity( c );
                }
            }
            if ( c >= 1 )
            {
                finish();
                return;
            }
        }
        update();
    }

    // The page underneath, as it will look: the QML pages and the sidebar are QQuickWidgets, which Qt composites over
    // plain widgets (WsStyle's dialog dim found the same), so they stay hidden under the curtain; grab() renders them.
    void startFade()
    {
        m_fading = true;
        // The window without the curtain, then each page rendered by its own scene (grabFramebuffer renders a page
        // that has never been on screen; the window's grab() left it blank) at its place.
        hide();
        m_snap = m_win->grab();
        show();
        raise();
        {
            QPainter p( &m_snap );
            for ( auto* q : m_win->findChildren< QQuickWidget* >() )
            {
                if ( q->property( "wsHiddenForIntro" ).toBool() )
                {
                    const QImage img = q->grabFramebuffer();
                    p.drawImage( QRectF( q->mapTo( m_win, QPoint( 0, 0 ) ), QSizeF( q->size() ) ), img );
                }
            }
        }
        m_fadeStart = monotonicUs();
    }

    void finish()
    {
        m_tick.stop();
        qApp->removeEventFilter( this );
        for ( const auto& w : std::as_const( m_offScreen ) )
        {
            if ( w )
            {
                w->setAttribute( Qt::WA_DontShowOnScreen, false );
                if ( w->isVisible() )
                {
                    w->hide();
                    w->show();
                }
            }
        }
        for ( const auto& item : std::as_const( m_contents ) )
        {
            if ( item )
            {
                item->setOpacity( 1 );
            }
        }
        for ( const auto& c : std::as_const( m_colors ) )
        {
            if ( c.first )
            {
                c.first->setColor( c.second );
            }
        }
        showPages();
        m_win->removeEventFilter( this );
        hide();
        deleteLater();
    }

    void hidePages()
    {
        // A window container's page is a window of its own (a subsurface over the window): unmap the window, keep the
        // container where the layout put it.
        if ( QWindow* top = m_win->windowHandle() )
        {
            for ( QWindow* w : QGuiApplication::allWindows() )
            {
                QWindow* a = w->parent();
                while ( a && a != top )
                {
                    a = a->parent();
                }
                if ( a == top && w->isVisible() && !m_hiddenWindows.contains( w ) )
                {
                    m_hiddenWindows << w;
                    w->hide();
                }
            }
        }
        for ( QWidget* q : m_win->findChildren< QWidget* >() )
        {
            if ( q->inherits( "QQuickWidget" ) && !q->isHidden()
                 && !q->property( "wsHiddenForIntro" ).toBool() )
            {
                QSizePolicy sp = q->sizePolicy();
                q->setProperty( "wsIntroKeep", sp.retainSizeWhenHidden() );
                sp.setRetainSizeWhenHidden( true );
                q->setSizePolicy( sp );
                q->setProperty( "wsHiddenForIntro", true );
                q->hide();
            }
        }
    }

    void showPages()
    {
        for ( const QPointer< QWindow >& w : std::as_const( m_hiddenWindows ) )
        {
            if ( auto* qw = qobject_cast< QQuickWindow* >( w.data() ) )
            {
                m_colors << qMakePair( QPointer< QQuickWindow >( qw ), qw->color() );
                qw->setColor( PAGE );
                qw->contentItem()->setOpacity( 0 );
                m_contents << qw->contentItem();
            }
            if ( w )
            {
                w->show();
            }
        }
        m_hiddenWindows.clear();
        for ( QWidget* q : m_win->findChildren< QWidget* >() )
        {
            if ( q->property( "wsHiddenForIntro" ).toBool() )
            {
                q->setProperty( "wsHiddenForIntro", false );
                q->show();
                QSizePolicy sp = q->sizePolicy();
                sp.setRetainSizeWhenHidden( q->property( "wsIntroKeep" ).toBool() );
                q->setSizePolicy( sp );
            }
        }
    }

    WsIntro::Options m_o;
    QWidget* m_win;
    QTimer m_tick;
    QPixmap m_snap;
    QList< QPointer< QWindow > > m_hiddenWindows;
    QList< QPointer< QQuickItem > > m_contents;
    QList< QPointer< QWidget > > m_offScreen;
    QList< QPair< QPointer< QQuickWindow >, QColor > > m_colors;
    qint64 m_shown = 0;
    qint64 m_fadeStart = 0;
    bool m_fading = false;
    qint64 m_returned = 0;
};

class Watcher : public QObject
{
public:
    Watcher( const WsIntro::Options& o, QObject* parent )
        : QObject( parent )
        , m_o( o )
    {
    }

    bool eventFilter( QObject* o, QEvent* e ) override
    {
        // Calamares shows its loading spinners for a moment as windows of their own before they move into the main
        // window, where they stay native: subsurfaces over the curtain. Off screen until the curtain is gone.
        if ( o->isWidgetType() && o->inherits( "WaitingSpinnerWidget" ) )
        {
            auto* w = static_cast< QWidget* >( o );
            if ( e->type() == QEvent::Show && w->isWindow() )
            {
                w->setAttribute( Qt::WA_DontShowOnScreen );
                m_spinners << w;
            }
        }
        // As soon as the main window has a native window (window containers make it, and their pages, native before
        // it shows; a page's spinner was on screen for a frame before the window's Show), at the latest when it shows.
        if ( ( e->type() == QEvent::Show || e->type() == QEvent::WinIdChange ) && o->isWidgetType()
             && o->objectName() == QLatin1String( "mainApp" ) )
        {
            auto* w = static_cast< QWidget* >( o );
            if ( w->isWindow() )
            {
                qApp->removeEventFilter( this );
                auto* c = static_cast< Curtain* >( WsIntro::cover( w, m_o ) );
                c->keepOffScreen( m_spinners );
                deleteLater();
            }
        }
        return false;
    }

private:
    WsIntro::Options m_o;
    QList< QPointer< QWidget > > m_spinners;
};
}  // namespace

namespace WsIntro
{
Options
fromEnvironment()
{
    Options o;
    const QByteArray t0 = qgetenv( "WORKSUITE_INTRO_T0" );
    o.enabled = !t0.isEmpty();
    o.t0Us = t0.toLongLong();
    o.title = qEnvironmentVariable( "WORKSUITE_INTRO_TITLE" );
    if ( o.title.isEmpty() )
    {
        o.title = tr( "Starting the installer…" );
    }
    o.version = qEnvironmentVariable( "WORKSUITE_INTRO_VERSION", QStringLiteral( "WorkSuite OS" ) );
    o.reducedMotion = qgetenv( "WORKSUITE_REDUCED_MOTION" ) == "1";
    return o;
}

void
install()
{
    static bool done = false;
    if ( done || !qApp )
    {
        return;
    }
    done = true;
    const Options o = fromEnvironment();
    if ( o.enabled )
    {
        qApp->installEventFilter( new Watcher( o, qApp ) );
    }
}

QWidget*
cover( QWidget* window, const Options& o )
{
    return new Curtain( window, o );
}
}  // namespace WsIntro
