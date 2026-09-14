from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, TabbedContent, TabPane
from textual.containers import Container
from founder_terminal.config import load_config
from founder_terminal.tui.screens.dashboard import DashboardScreen
from founder_terminal.tui.screens.terminal_workspace import TerminalWorkspaceScreen
from founder_terminal.tui.screens.runs import RunsScreen
from founder_terminal.tui.screens.openhands_readiness import OpenHandsReadinessScreen
from founder_terminal.tui.screens.openrouter_management import OpenRouterManagementScreen

class FounderTerminalApp(App):
    TITLE = "TIMMY AGENT OPS CONSOLE"
    SUB_TITLE = "V1 Core Control Plane • © 2026 The TIMMY authors"
    
    CSS = """
    Screen {
        background: #0d1117;
        color: #c9d1d9;
    }
    
    Header {
        background: #161b22;
        color: #5e6ad2;
        text-style: bold;
        border-bottom: solid #30363d;
    }
    
    Footer {
        background: #161b22;
        color: #8b949e;
        border-top: solid #30363d;
    }

    TabbedContent {
        background: #0d1117;
    }

    TabPane {
        padding: 1 2;
        background: #0d1117;
    }

    .status-card {
        border: round #30363d;
        padding: 1 2;
        background: #161b22;
        margin: 1 0;
    }

    .accent-title {
        color: #58a6ff;
        text-style: bold;
    }
    """

    BINDINGS = [
        ("q", "quit", "Quit Console"),
        ("ctrl+l", "clear_history", "Clear Runs"),
    ]

    def compose(self) -> ComposeResult:
        # Load core environment variables on mount
        self.config = load_config()
        
        yield Header(show_clock=True)
        with TabbedContent(initial="dashboard"):
            with TabPane("📊 Dashboard", id="dashboard"):
                yield DashboardScreen(self.config)
            with TabPane("🖥️ Terminal Workspace", id="workspace"):
                yield TerminalWorkspaceScreen(self.config)
            with TabPane("🛡️ OpenHands Readiness", id="readiness"):
                yield OpenHandsReadinessScreen(self.config)
            with TabPane("🤖 OpenRouter Console", id="openrouter"):
                yield OpenRouterManagementScreen(self.config)
            with TabPane("⚡ Runs / Cockpit", id="runs"):
                yield RunsScreen(self.config)
        yield Footer()

    def action_clear_history(self) -> None:
        # Stub action to clear run list
        pass

