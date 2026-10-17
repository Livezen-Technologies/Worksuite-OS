/* worksuite-polkit-listener: the polkit side of WorkSuite's authentication agent (G05, WSOS-INT-010).
 *
 * A PolkitAgentListener in C. The Python agent (worksuite_polkit_agent) runs it with pipes and does everything else:
 * the shell socket, the identity choice and the faillock bookkeeping. polkit's API is written for C; a PyGObject
 * subclass of PolkitAgent.Listener loses the GAsyncReadyCallback's user_data on the way through Gio.Task, so
 * libpolkit-agent-1's auth_cb dereferenced NULL (SIGSEGV at libpolkit-agent-1.so.0+0x5baa) whenever a request ended.
 *
 * One line per message, fields separated by tabs; backslash, tab and newline in a field are written \\ \t \n.
 *
 *   listener -> agent  ready
 *                      fatal <text>
 *                      detail <id> <key> <value>               (before begin, one per polkit detail)
 *                      begin <id> <action_id> <message> <icon> <uid,uid,...>
 *                      request <id> <prompt> <echo 0|1>         PAM asks (answer with respond)
 *                      info <id> <text> / error <id> <text>     PAM text
 *                      completed <id> <gained 0|1>              one PAM conversation ended
 *                      cancelled <id>                           polkit withdrew the request (already returned)
 *   agent -> listener  start <id> <uid>                         run PAM for this user (again, after a failure)
 *                      respond <id> <text>
 *                      finish <id> ok|cancel|fail               return the request to polkit
 *
 * End of input ends the listener. Usage: worksuite-polkit-listener [--process PID]  (default: this login session;
 * --process registers for one process instead, which the integration test uses where there is no logind).
 */
#define POLKIT_AGENT_I_KNOW_API_IS_SUBJECT_TO_CHANGE
#include <polkitagent/polkitagent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define OBJECT_PATH "/lk/worksuite/PolkitAgent"

typedef struct {
    guint id;
    GTask *task;
    gchar *cookie;
    PolkitAgentSession *session;
    GCancellable *cancellable;
    gulong cancel_id;
} Req;

static GHashTable *reqs; /* id -> Req* */
static guint next_id = 1;
static GMainLoop *loop;

static void put_field(GString *s, const char *f)
{
    g_string_append_c(s, '\t');
    for (; f && *f; f++) {
        if (*f == '\\')
            g_string_append(s, "\\\\");
        else if (*f == '\t')
            g_string_append(s, "\\t");
        else if (*f == '\n')
            g_string_append(s, "\\n");
        else
            g_string_append_c(s, *f);
    }
}

/* emit(kind, id or 0, NULL-terminated fields) */
static void emit(const char *kind, guint id, ...)
{
    GString *s = g_string_new(kind);
    if (id) g_string_append_printf(s, "\t%u", id);
    va_list ap;
    va_start(ap, id);
    const char *f;
    while ((f = va_arg(ap, const char *)) != NULL)
        put_field(s, f);
    va_end(ap);
    g_string_append_c(s, '\n');
    fwrite(s->str, 1, s->len, stdout);
    fflush(stdout);
    g_string_free(s, TRUE);
}

static gboolean unref_idle(gpointer obj)
{
    g_object_unref(obj);
    return G_SOURCE_REMOVE;
}

/* Drop the request's PAM session. It is released from idle: never inside its own signal emission. */
static void drop_session(Req *r, gboolean cancel)
{
    PolkitAgentSession *s = r->session;
    if (!s) return;
    r->session = NULL;
    g_signal_handlers_disconnect_by_data(s, GUINT_TO_POINTER(r->id));
    if (cancel) polkit_agent_session_cancel(s);
    g_idle_add(unref_idle, s);
}

static void req_free(Req *r)
{
    drop_session(r, TRUE);
    if (r->cancellable) {
        /* g_cancellable_disconnect waits for a running handler; ours only queues an idle, so this cannot block. */
        if (r->cancel_id) g_cancellable_disconnect(r->cancellable, r->cancel_id);
        g_object_unref(r->cancellable);
    }
    if (r->task) g_object_unref(r->task);
    g_free(r->cookie);
    g_free(r);
}

/* Return the request to polkit exactly once and forget it. */
static void req_finish(Req *r, const char *how)
{
    GTask *t = r->task;
    r->task = NULL;
    g_hash_table_steal(reqs, GUINT_TO_POINTER(r->id));
    drop_session(r, TRUE);
    if (t) {
        if (g_strcmp0(how, "ok") == 0)
            g_task_return_boolean(t, TRUE);
        else if (g_strcmp0(how, "cancel") == 0)
            g_task_return_new_error(t, POLKIT_ERROR, POLKIT_ERROR_CANCELLED, "Authentication was cancelled");
        else
            g_task_return_new_error(t, POLKIT_ERROR, POLKIT_ERROR_FAILED, "Authentication failed");
        g_object_unref(t);
    }
    req_free(r);
}

static Req *req_of(gpointer data)
{
    return g_hash_table_lookup(reqs, data);
}

static void on_request(PolkitAgentSession *s, const gchar *prompt, gboolean echo_on, gpointer data)
{
    Req *r = req_of(data);
    if (r && r->session == s) emit("request", r->id, prompt, echo_on ? "1" : "0", NULL);
}

static void on_info(PolkitAgentSession *s, const gchar *text, gpointer data)
{
    Req *r = req_of(data);
    if (r && r->session == s) emit("info", r->id, text, NULL);
}

static void on_error(PolkitAgentSession *s, const gchar *text, gpointer data)
{
    Req *r = req_of(data);
    if (r && r->session == s) emit("error", r->id, text, NULL);
}

static void on_completed(PolkitAgentSession *s, gboolean gained, gpointer data)
{
    Req *r = req_of(data);
    if (!r || r->session != s) return;
    drop_session(r, FALSE);
    emit("completed", r->id, gained ? "1" : "0", NULL);
}

static gboolean cancelled_idle(gpointer data)
{
    Req *r = req_of(data);
    if (r) {
        guint id = r->id;
        req_finish(r, "cancel");
        emit("cancelled", id, NULL);
    }
    return G_SOURCE_REMOVE;
}

static void on_cancelled(GCancellable *c, gpointer data)
{
    (void)c;
    g_idle_add(cancelled_idle, data);
}

typedef struct { PolkitAgentListener parent; } WsListener;
typedef struct { PolkitAgentListenerClass parent_class; } WsListenerClass;
G_DEFINE_TYPE(WsListener, ws_listener, POLKIT_AGENT_TYPE_LISTENER)

static void initiate(PolkitAgentListener *l, const gchar *action_id, const gchar *message, const gchar *icon_name,
                     PolkitDetails *details, const gchar *cookie, GList *identities, GCancellable *cancellable,
                     GAsyncReadyCallback callback, gpointer user_data)
{
    Req *r = g_new0(Req, 1);
    r->id = next_id++;
    r->task = g_task_new(l, cancellable, callback, user_data);
    r->cookie = g_strdup(cookie);
    g_hash_table_insert(reqs, GUINT_TO_POINTER(r->id), r);

    if (details) {
        gchar **keys = polkit_details_get_keys(details);
        for (gchar **k = keys; k && *k; k++)
            emit("detail", r->id, *k, polkit_details_lookup(details, *k), NULL);
        g_strfreev(keys);
    }
    GString *uids = g_string_new(NULL);
    for (GList *i = identities; i; i = i->next) {
        if (!POLKIT_IS_UNIX_USER(i->data)) continue;
        g_string_append_printf(uids, "%s%d", uids->len ? "," : "", polkit_unix_user_get_uid(POLKIT_UNIX_USER(i->data)));
    }
    emit("begin", r->id, action_id, message, icon_name ? icon_name : "", uids->str, NULL);
    g_string_free(uids, TRUE);

    if (cancellable) {
        r->cancellable = g_object_ref(cancellable);
        r->cancel_id = g_cancellable_connect(cancellable, G_CALLBACK(on_cancelled), GUINT_TO_POINTER(r->id), NULL);
    }
}

static gboolean initiate_finish(PolkitAgentListener *l, GAsyncResult *res, GError **error)
{
    (void)l;
    return g_task_propagate_boolean(G_TASK(res), error);
}

static void ws_listener_init(WsListener *self) { (void)self; }

static void ws_listener_class_init(WsListenerClass *k)
{
    PolkitAgentListenerClass *lk = POLKIT_AGENT_LISTENER_CLASS(k);
    lk->initiate_authentication = initiate;
    lk->initiate_authentication_finish = initiate_finish;
}

static gchar *unescape(const char *f)
{
    GString *s = g_string_new(NULL);
    for (; *f; f++) {
        if (*f == '\\' && f[1]) {
            f++;
            g_string_append_c(s, *f == 't' ? '\t' : *f == 'n' ? '\n' : *f);
        } else {
            g_string_append_c(s, *f);
        }
    }
    return g_string_free(s, FALSE);
}

static void command(char *line)
{
    gchar **f = g_strsplit(line, "\t", 4);
    guint n = g_strv_length(f);
    Req *r = n >= 2 ? req_of(GUINT_TO_POINTER((guint)strtoul(f[1], NULL, 10))) : NULL;
    if (!r) goto out;
    if (g_strcmp0(f[0], "start") == 0 && n >= 3) {
        drop_session(r, TRUE);
        PolkitIdentity *who = polkit_unix_user_new((gint)strtol(f[2], NULL, 10));
        r->session = polkit_agent_session_new(who, r->cookie);
        g_object_unref(who);
        gpointer d = GUINT_TO_POINTER(r->id);
        g_signal_connect(r->session, "request", G_CALLBACK(on_request), d);
        g_signal_connect(r->session, "show-info", G_CALLBACK(on_info), d);
        g_signal_connect(r->session, "show-error", G_CALLBACK(on_error), d);
        g_signal_connect(r->session, "completed", G_CALLBACK(on_completed), d);
        polkit_agent_session_initiate(r->session);
    } else if (g_strcmp0(f[0], "respond") == 0 && n >= 3 && r->session) {
        gchar *pw = unescape(f[2]);
        polkit_agent_session_response(r->session, pw);
        memset(pw, 0, strlen(pw));
        g_free(pw);
    } else if (g_strcmp0(f[0], "finish") == 0 && n >= 3) {
        req_finish(r, f[2]);
    }
out:
    if (n >= 3) memset(f[2], 0, strlen(f[2])); /* the password, when there was one */
    g_strfreev(f);
}

static gboolean on_stdin(GIOChannel *ch, GIOCondition cond, gpointer data)
{
    (void)cond;
    (void)data;
    gchar *line = NULL;
    gsize len = 0, term = 0;
    GIOStatus st;
    while ((st = g_io_channel_read_line(ch, &line, &len, &term, NULL)) == G_IO_STATUS_NORMAL) {
        line[term] = '\0';
        command(line);
        memset(line, 0, len);
        g_free(line);
        line = NULL;
    }
    if (st == G_IO_STATUS_EOF || st == G_IO_STATUS_ERROR) {
        g_main_loop_quit(loop);
        return G_SOURCE_REMOVE;
    }
    return G_SOURCE_CONTINUE;
}

int main(int argc, char **argv)
{
    GError *err = NULL;
    PolkitSubject *subject = NULL;
    if (argc == 3 && strcmp(argv[1], "--process") == 0)
        subject = polkit_unix_process_new_for_owner(atoi(argv[2]), 0, -1);
    else
        subject = polkit_unix_session_new_for_process_sync(getpid(), NULL, &err);
    if (!subject) {
        gchar *m = g_strdup_printf("no login session: %s", err ? err->message : "unknown");
        emit("fatal", 0, m, NULL);
        return 1;
    }
    reqs = g_hash_table_new(g_direct_hash, g_direct_equal);
    loop = g_main_loop_new(NULL, FALSE);
    PolkitAgentListener *listener = g_object_new(ws_listener_get_type(), NULL);
    gpointer handle = polkit_agent_listener_register(listener, POLKIT_AGENT_REGISTER_FLAGS_NONE, subject, OBJECT_PATH,
                                                     NULL, &err);
    if (!handle) {
        emit("fatal", 0, err ? err->message : "could not register", NULL);
        return 1;
    }
    GIOChannel *in = g_io_channel_unix_new(STDIN_FILENO);
    g_io_channel_set_encoding(in, NULL, NULL);
    g_io_channel_set_flags(in, G_IO_FLAG_NONBLOCK, NULL);
    g_io_add_watch(in, G_IO_IN | G_IO_HUP | G_IO_ERR, on_stdin, NULL);
    emit("ready", 0, NULL);
    g_main_loop_run(loop);
    polkit_agent_listener_unregister(handle);
    g_object_unref(listener);
    g_object_unref(subject);
    return 0;
}
