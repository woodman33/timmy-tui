// R12 (the finish brief): Models & accounts — where Timmy's model runs. The providers (each one card: its Rive ProviderCard face,
// its name and state once, its actions once, its endpoint facts in Details), the models on this computer (asked with permission
// first), the cloud models an Ollama account adds, and OpenRouter's catalog. Choosing a model writes the setup's choice
// (POST /api/chat/choose); "Continue to workspace" then opens the Chat.
import { Catalog, ChooseResult, CloudModels, LocalModels, ProviderCard, chosenOf, whereOf } from '../models-parts.jsx';
import { Page, Panel } from '../shell.jsx';
import { checkProvider, goTo, loadModels, useApp } from '../store.js';
import { Button, Empty, Facts, StateWord } from '../ui.jsx';

export default function ModelsPage() {
  const theme = useApp((s) => s.theme);
  const view = useApp((s) => s.view);
  const permission = useApp((s) => s.localPermission);
  const asking = useApp((s) => s.modelsAsking);
  const note = useApp((s) => s.note);
  const providers = view && Array.isArray(view.providers) ? view.providers : [];
  const chosen = chosenOf(view);
  const ready = view && view.route && view.route.ready;
  const live = providers.filter((p) => p.state === 'checked' || p.state === 'connected').length;
  const c = view && view.choice ? view.choice : {};
  return (
    <Page id="models" note={note}
      actions={ready ? <Button kind="primary" onClick={() => goTo('chat')}>Continue to workspace →</Button>
        : permission !== 'granted' ? <Button kind="primary" onClick={() => document.querySelector('[data-panel="local"] .ta-btn-primary')?.focus()}>Find models on this computer</Button> : null}
      band={[
        ['CHOSEN', chosen ? <>{chosen.model} <span className="ta-muted">· {whereOf(view.route)}</span></> : <span className="ta-muted">none · Send is off</span>],
        ['PROVIDERS', view ? <>{live} of {providers.length} <span className="ta-muted">checked</span></> : <span className="ta-muted">reading…</span>],
        ['THIS COMPUTER', permission === 'granted' ? <StateWord word="asked with permission" /> : <span className="ta-muted">{permission === 'declined' ? 'not asked (you said not now)' : 'not asked yet'}</span>],
      ]}
      context={(
        <>
          <Facts rows={[
            ['next turn', c.words || null],
            ['chosen in', c.from || null],
            ['check', c.check ? <span key="c"><StateWord word={c.check.state} live={c.check.state === 'ready'} /> {c.check.words}</span> : null],
            ['policy', view && view.policy ? `free only ${view.policy.freeOnly ? 'on' : 'off'} · local only ${view.policy.localOnly ? 'on' : 'off'}` : null],
          ]} />
          {!chosen ? <Empty>No model is chosen. Use one below; the Chat sends with it.</Empty> : null}
          <ChooseResult />
        </>
      )}>
      <div className="ta-grid-2">
        <Panel id="local" kicker="ON THIS COMPUTER" title="Your models, found with your permission"
          tools={permission === 'granted' ? <Button onClick={() => Promise.all([checkProvider('ollama-local'), loadModels('ollama-local', { fresh: true }), loadModels('ollama-cloud')])} disabled={asking['ollama-local']}>{asking['ollama-local'] ? 'Looking…' : 'Look again'}</Button> : null}>
          <LocalModels />
          <h3 className="ta-sub">Cloud models through your Ollama account</h3>
          <CloudModels />
        </Panel>
        <Panel id="providers" kicker="ACCOUNTS" title="Where models can run">
          {!providers.length ? <Empty>{view ? 'The companion listed no providers.' : 'Reading the providers…'}</Empty>
            : <div className="ta-providers">{providers.map((p) => <ProviderCard key={p.id} p={p} theme={theme} />)}</div>}
        </Panel>
      </div>
      <Panel id="catalog" kicker="CLOUD MODELS" title="OpenRouter’s catalog">
        <Catalog />
        <ChooseResult source="openrouter" />
      </Panel>
    </Page>
  );
}
