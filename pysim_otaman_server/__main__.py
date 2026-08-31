import argparse
import logging
import os
import sys
import time
import traceback
from http.server import HTTPServer
from pySim.card_handler import CardHandler
from pySim.commands import SimCardCommands
from pySim.log import PySimLogger
from pySim.cards import UiccCardBase

from .shell import load_pysim_app
from .server import PysimHandler, StderrApduTracer, _LoggingApduTracer, VERSION, _send_terminal_profile, _DefaultProactiveHandler, _handle_proactive_chain, _send_status, _init_proactive_session


_server_start = 0

def _log_stdout(msg):
    elapsed = time.time() - _server_start
    os.write(1, ('[%8.3f] %s\n' % (elapsed, msg)).encode())


def _default_web_dir():
    # <repo>/frontend, whether run from source or an editable install.
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'frontend')


def main():
    global _server_start
    _server_start = time.time()
    mod = load_pysim_app()
    parser = mod.option_parser
    parser.description = 'pysim-otaman-server — HTTP API for pysim'
    parser.add_argument('--http-host', default='127.0.0.1', help='Bind address (default: 127.0.0.1)')
    parser.add_argument('--http-port', type=int, default=8080, help='Bind port (default: 8080)')
    parser.add_argument('--web-dir', default=_default_web_dir(), metavar='PATH',
                        help='Directory with the OTAMan PWA static files to serve (default: <repo>/frontend)')
    parser.add_argument('--log-requests', action='store_true', default=False, help='Log request/response payloads to stderr')
    parser.add_argument('--sms-oa', default='12345', metavar='DIGITS',
                        help='TP-Originating-Address (SMSC number) for the SMS-DELIVER TPDU (default: 12345)')
    parser.add_argument('--sms-sm-sc', default='12345678912', metavar='DIGITS',
                        help='SM-SC address for SMS-SUBMIT routing in PoR-in-submit mode (default: 12345678912)')
    parser.add_argument('--terminal-profile', default='7FFFFFFFFF0000CF02', metavar='HEX',
                        help='TERMINAL PROFILE payload (default: 10-byte profile with SMS-PP download and event list)')
    parser.add_argument('--poll-interval', type=int, default=30, metavar='SECS',
                        help='Idle interval before automatic STATUS polling (1-255 seconds, default: 30). Disable with --poll-interval 0')
    parser.add_argument('--no-card-init', action='store_true', default=False,
                        help='Skip pysim card initialization (preserve CAT session — no file manager)')

    opts = parser.parse_args()
    opts.skip_card_init = opts.no_card_init
    sl = None
    scc = None
    card = None
    rs = None
    sim_menu = None
    event_list = None
    # Auto-detect PC/SC reader if none was explicitly specified.
    # Handles late pcscd startup and USB enumeration delays.
    if opts.pcsc_dev is None and opts.pcsc_regex is None:
        try:
            from smartcard.System import readers
            for attempt in range(3):
                r = readers()
                if r:
                    sys.stderr.write('INIT: PC/SC reader detected: %s\n' % r[0])
                    opts.pcsc_dev = 0
                    break
                if attempt < 2:
                    sys.stderr.write('INIT: no PC/SC readers found, retrying in 2s...\n')
                    time.sleep(2)
        except Exception:
            pass  # smartcard module not available or pcscd unreachable

    try:
        kwargs = {}
        if opts.apdu_trace:
            kwargs['apdu_tracer'] = _LoggingApduTracer()
        sl = mod.init_reader(opts, **kwargs)
        scc = SimCardCommands(sl)
        scc.cat_cla = '80'  # UICC CLA default; overridden for SIM after init_card
        scc._tp.proactive_handler = _DefaultProactiveHandler()
        sl.wait_for_card(3)
        rs, card = mod.init_card(sl, opts.skip_card_init)
        scc.cat_cla = '80' if isinstance(card, UiccCardBase) else 'a0'
    except Exception:
        print("Warning: reader/card initialization failed:", file=sys.stderr)
        traceback.print_exc()
    ch = CardHandler(sl) if sl else None
    try:
        app = mod.PysimApp(verbose=opts.verbose, card=card, rs=rs, sl=sl, ch=ch)
    except Exception:
        print("Warning: PysimApp creation failed:", file=sys.stderr)
        traceback.print_exc()
        app = None
    if scc and hasattr(scc, '_tp'):
        scc._tp.apdu_tracer = _LoggingApduTracer()
        try:
            _init_proactive_session()
            sys.stderr.write('INIT: sending TERMINAL PROFILE %s (CLA=%s)\n' % (opts.terminal_profile, scc.cat_cla))
            sm, el = _send_terminal_profile(scc, opts.terminal_profile)
            sys.stderr.write('INIT: TP done, menu=%s events=%s\n' % ('yes' if sm else 'no', 'yes' if el else 'no'))
            sim_menu = sm or sim_menu
            event_list = el or event_list
            for _ in range(3):
                st_data, st_sw = _send_status(scc)
                sys.stderr.write('INIT: drain STATUS -> %s\n' % st_sw)
                if not st_sw.startswith('91'):
                    break
                _handle_proactive_chain(scc, st_sw)
        except Exception:
            traceback.print_exc(file=sys.stderr)
    if app is not None and opts.apdu_trace:
        # PysimApp.__init__ routes PySimLogger through app.poutput() (app.stdout)
        # and drops the root level to INFO. Re-route pysim's own APDU trace logging
        # directly to fd 1 so it survives the app.stdout/StringIO redirection in the
        # HTTP handlers and the INFO level suppression.
        PySimLogger.setup(print_callback=_log_stdout)
        PySimLogger.set_level(logging.DEBUG)
        # PysimApp.__init__ and every `equip` wipe the transport apdu_tracer
        # (_onchange_apdu_trace sets it to None). Re-attach our tracer and make
        # sure it stays attached across equip/re-equip.
        tracer = _LoggingApduTracer()
        def _reattach_tracer():
            if app.card:
                app.card._scc._tp.apdu_tracer = tracer
        _reattach_tracer()
        orig_onchange = app._onchange_apdu_trace
        def _onchange_apdu_trace(param_name, old, new):
            orig_onchange(param_name, old, new)
            _reattach_tracer()
        app._onchange_apdu_trace = _onchange_apdu_trace
    server = HTTPServer((opts.http_host, opts.http_port), PysimHandler)
    server.sl = sl
    server.scc = scc
    server.card = card
    server.rs = rs
    server.app = app
    server.sms_oa = opts.sms_oa
    server.sms_sc = opts.sms_sm_sc
    server.log_requests = opts.log_requests
    server.terminal_profile = opts.terminal_profile
    server.web_dir = opts.web_dir
    server.sim_menu = sim_menu
    server.event_list = event_list
    server.menu_active = False
    server.stk_pending = None
    # Set server reference for polling timer and mark card as connected
    import pysim_otaman_server.server
    pysim_otaman_server.server._server_ref = server
    pysim_otaman_server.server._CARD_CONNECTED = True
    if opts.poll_interval is not None:
        pysim_otaman_server.server._set_poll_interval(opts.poll_interval)
    # Auto-enable polling if card initialized successfully (unless interval is 0)
    if server.scc and server.card and opts.poll_interval != 0:
        pysim_otaman_server.server._poll_enable()
    print("─" * 70)
    print("  pysim-otaman-server v%s listening on http://%s:%s" % (VERSION, opts.http_host, opts.http_port))
    print("  Open http://%s:%s in your browser for the OTAMan UI (served by this server)."
          % (opts.http_host, opts.http_port))
    print("─" * 70)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()