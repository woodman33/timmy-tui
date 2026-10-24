#!/usr/bin/env python3
"""
timmy-ui — the native Rive UI's editable source (RIVE CONTRACT v2, R11 round 7, H174).

Writes scene.rml (the Rive markup the Rive CLI compiles: `rive . --verify`, `rive . --once` → timmy-ui.riv) and rive.yaml
(what the companion's listing reads) beside this file. Python 3.12+ (f-strings with nested quotes). The compiled .riv is
built on the operator's machine by the Rive CLI and committed beside this source with its sha256 (CONTRACT.json, README).

Artboards (sizes are the consumers' aspect rules: rive-components.css, companion/studio-canvas/index.html):
  PRODUCTION  AgentConsole 640×380 · ProviderCard 400×260 · ActionButton 240×72 (Amber) · ActionButtonGlacier 240×72
  PREVIEW     AgentConsolePreview · ProviderCardPreview · ActionButtonPreview — the Inspect view only: these bake the
              caption "PREVIEW / NOT A LIVE JOB" and the "Inspect click" listener (State → 1); the production artboards bake
              no preview caption, no "Inspect interaction" pill and no state-changing listener.
State machine TimmyUI on every artboard: State (Number: 0 Idle · 1 Working/Checking · 2 Approval · 3 Stopped · 4 Failed; no
success value), Hover (Bool), Pressed (Bool), ReducedMotion (Bool: zero-duration transitions AND the Working ring does not
spin — the WorkingStill state — so nothing keeps moving).
Named text runs (one name each; the runtime sets them by name): see RUNS below and CONTRACT.json.
Font: Outfit (variable, OFL) — Outfit.ttf beside this file, made by make-font.py from the font this product serves.
Materials: the Card Lab direction (DESIGN.md B11, the study's token registry v0.1): canvas #080B0F, surface #111A23,
raised #1C2936, border #44586B, text #ECF1F5, secondary #BDCADA, muted #9AAFC3; focus/intent #FFB000; the primary action
= the accent family's gradient (amber #F0E5D4 → #D6AA64 with ink #5B421D; glacier #E1EEF7 → #8ABBE3 with ink #244761).
Never #28FE14 on a native face: no observed-live claim is drawn, the HTML words say it.
"""
from pathlib import Path
import xml.sax.saxutils as xml

p = Path(__file__).parent

# ── the palette (ARGB hex, as RML takes it) ──────────────────────────────────────────────────────────────────────────────
CANVAS, SURFACE, RAISED, BORDER = 'FF080B0F', 'FF111A23', 'FF1C2936', 'FF44586B'
TEXT, SECONDARY, MUTED = 'FFECF1F5', 'FFBDCADA', 'FF9AAFC3'
FOCUS = 'FFFFB000'            # focus / intent / attention (B10): the Working ring, Approval, Failed
STOPPED = 'FF9AAFC3'          # a stopped state is quiet
THEMES = {
    'amber':   {'start': 'FFF0E5D4', 'accent': 'FFD6AA64', 'soft': 'FFEAD0A3', 'ink': 'FF5B421D'},
    'glacier': {'start': 'FFE1EEF7', 'accent': 'FF8ABBE3', 'soft': 'FFBED9ED', 'ink': 'FF244761'},
}
PREVIEW_CAPTION = 'PREVIEW  /  NOT A LIVE JOB'

counter = 10
FONT = '0:1'


def ident():
    global counter
    counter += 1
    return f'0:{counter}'


def esc(value):
    return xml.escape(value, {'"': '&quot;'})


def rect(x, y, w, h, color, name='', radius=0, stroke=None, opacity=1, stroke_width=1):
    """A rectangle centred at (x, y); a solid fill (None for none) and an optional stroke."""
    sid = ident()
    paint = f'<Fill><SolidColor colorValue="{color}"/></Fill>' if color else ''
    if stroke:
        paint += f'<Stroke thickness="{stroke_width}"><SolidColor colorValue="{stroke}"/></Stroke>'
    return sid, (f'<Shape x="{x}" y="{y}" opacity="{opacity}" name="{name}" id="{sid}">'
                 f'<Rectangle width="{w}" height="{h}" originX="0.5" originY="0.5" cornerRadiusTL="{radius}"/>{paint}</Shape>')


def gradient_rect(x, y, w, h, stops, name='', radius=0, stroke=None, direction='down', opacity=1):
    """A rectangle filled with a linear gradient (stops: [(position, ARGB)…]); 'down' = top → bottom, 'diagonal' = top-left → bottom-right."""
    sid = ident()
    sx, sy, ex, ey = (0, -h / 2, 0, h / 2) if direction == 'down' else (-w / 2, -h / 2, w / 2, h / 2)
    grad = f'<LinearGradient startX="{sx}" startY="{sy}" endX="{ex}" endY="{ey}">' + ''.join(f'<GradientStop colorValue="{c}" position="{pos}"/>' for pos, c in stops) + '</LinearGradient>'
    paint = f'<Fill>{grad}</Fill>'
    if stroke:
        paint += f'<Stroke thickness="1"><SolidColor colorValue="{stroke}"/></Stroke>'
    return sid, (f'<Shape x="{x}" y="{y}" opacity="{opacity}" name="{name}" id="{sid}">'
                 f'<Rectangle width="{w}" height="{h}" originX="0.5" originY="0.5" cornerRadiusTL="{radius}"/>{paint}</Shape>')


def text(x, y, value, size=14, color=TEXT, name='', weight=None):
    """A text with ONE run; the run's name is `name` (the runtime sets it by that name), else its text."""
    sid, sty = ident(), ident()
    wght = weight if weight is not None else (600 if size >= 19 else 500)
    return sid, (f'<Text x="{x}" y="{y}" name="{name}" id="{sid}">'
                 f'<TextStylePaint fontSize="{size}" fontAssetId="{FONT}" familyName="Outfit" styleName="Regular" id="{sty}">'
                 f'<TextStyleAxis tag="2003265652" axisValue="{wght}"/><Fill><SolidColor colorValue="{color}"/></Fill></TextStylePaint>'
                 f'<TextValueRun styleId="{sty}" text="{esc(value)}" name="{esc(name or value)}"/></Text>')


def circle(x, y, r, color=FOCUS, width=2, trim=False):
    sid, tid = ident(), ident()
    trim_markup = f'<TrimPath start="0" end="0.68" id="{tid}"/>' if trim else ''
    return sid, tid, (f'<Shape x="{x}" y="{y}" id="{sid}"><Ellipse width="{r * 2}" height="{r * 2}" originX="0.5" originY="0.5"/>'
                      f'<Stroke thickness="{width}" cap="round"><SolidColor colorValue="{color}"/>{trim_markup}</Stroke></Shape>')


def bar(x, y, w, h, color, rotation=0.0, radius=1):
    """A filled bar centred at (x, y), rotated (radians): the vector glyphs are built from these (no glyph fonts needed)."""
    sid = ident()
    return (f'<Shape x="{x}" y="{y}" rotation="{rotation}" id="{sid}"><Rectangle width="{w}" height="{h}" originX="0.5" originY="0.5" cornerRadiusTL="{radius}"/>'
            f'<Fill><SolidColor colorValue="{color}"/></Fill></Shape>')


def key(obj, prop, values, color=False):
    kind = 'KeyFrameColor' if color else 'KeyFrameDouble'
    return (f'<KeyedObject objectId="{obj}"><KeyedProperty propertyKey="{prop}">'
            + ''.join(f'<{kind} frame="{frame}" value="{value}" interpolationType="linear"/>' for frame, value in values)
            + '</KeyedProperty></KeyedObject>')


def group(children, name, opacity=0):
    gid = ident()
    return gid, f'<Node opacity="{opacity}" name="{name}" id="{gid}">' + ''.join(children) + '</Node>'


STATES = ['Idle', 'Working', 'Approval', 'Stopped', 'Failed']
# the authored words per state (the operator's round-6 words kept), baked in the state groups under their own run names
WORDS = {
    'console': [('Ready when you are', 'Make room for the next thing you want to make.'),
                ('Working on your idea', 'A visible state, driven by the turn’s events.'),
                ('Your approval comes first', 'Inspect the change before it becomes your result.'),
                ('Stopped. You are in control.', 'No more motion until you choose the next step.'),
                ('Let’s try another route.', 'Keep the error visible. Keep a useful next action.')],
    'card': [('Choose your connection', ''), ('Checking your connection', ''), ('Review what you allow', ''),
             ('Connection stopped', ''), ('Could not connect', '')],
}
# the runs each artboard offers (CONTRACT.json "runs"): name → default text
RUNS = {
    'AgentConsole': {'Title': 'TIMMY  /  AGENT CONSOLE', 'Tag': 'NATIVE RIVE UI', 'Caption': ''},
    'ProviderCard': {'Title': 'TIMMY  /  PROVIDERS', 'Tag': 'NATIVE RIVE UI', 'Caption': '', 'ProviderName': 'Provider', 'ProviderState': '', 'ProviderDetail': ''},
    'ActionButton': {'Caption': 'Action'},
}


def glyph(kind, i, cx, cy, big):
    """The state's focal mark at (cx, cy): the T (Idle), the ring + bars (Working), the diamond (Approval), the square (Stopped), the × (Failed)."""
    out, ring = [], None
    r = 44 if big else 24
    _, _, base = circle(cx, cy, r, BORDER, 2)
    out.append(base)
    if i == 1:
        ring, _, markup = circle(cx, cy, r, FOCUS, 4, True)
        out.append(markup)
        for k in range(5):
            out.append(bar(cx - r + k * (r / 2), cy + r + (23 if big else 18), 8 if big else 5, 4 + k * (5 if big else 3), FOCUS, radius=2))
    elif i == 2:
        s = 30 if big else 16
        out.append(f'<Shape x="{cx}" y="{cy}" rotation="0.785398" id="{ident()}"><Rectangle width="{s}" height="{s}" originX="0.5" originY="0.5"/>'
                   f'<Stroke thickness="3"><SolidColor colorValue="{FOCUS}"/></Stroke></Shape>')
    elif i == 3:
        s = 24 if big else 14
        out.append(rect(cx, cy, s, s, STOPPED, radius=3)[1])
    elif i == 4:
        w = 36 if big else 22
        out.append(bar(cx, cy, w, 3, FOCUS, 0.785398))
        out.append(bar(cx, cy, w, 3, FOCUS, -0.785398))
    else:
        out.append(bar(cx, cy - 9, 32 if big else 21, 5, FOCUS))
        out.append(bar(cx, cy + 4, 5, 26 if big else 18, FOCUS))
    return out, ring


def button_mark(i, cx, cy, ink):
    """The ActionButton's right-hand mark per state: a chevron (Idle), three dots (Working), a diamond (Approval), a square (Stopped), an × (Failed)."""
    if i == 0:
        return [bar(cx - 3, cy, 16, 2.5, ink), bar(cx + 2, cy - 3.2, 9, 2.5, ink, 0.785398), bar(cx + 2, cy + 3.2, 9, 2.5, ink, -0.785398)]
    if i == 1:
        return [bar(cx - 8 + k * 8, cy, 4, 4, ink, radius=2) for k in range(3)]
    if i == 2:
        return [f'<Shape x="{cx}" y="{cy}" rotation="0.785398" id="{ident()}"><Rectangle width="11" height="11" originX="0.5" originY="0.5"/>'
                f'<Stroke thickness="2.5"><SolidColor colorValue="{ink}"/></Stroke></Shape>']
    if i == 3:
        return [rect(cx, cy, 11, 11, ink, radius=2)[1]]
    return [bar(cx, cy, 15, 2.5, ink, 0.785398), bar(cx, cy, 15, 2.5, ink, -0.785398)]


def machine(ids, states, hover_target=None, inspect_target=None, working_still=None):
    """The TimmyUI state machine: the Operation layer (State → a pose; ReducedMotion = instant, and Working without its spin),
    the Hover and Pressed layers, the pointer listeners on `hover_target` (the ActionButton only), the preview's click listener."""
    sm, state, hover, pressed, motion = ids
    lid = ident()
    def transitions(i, stid):
        if i == 1 and working_still:
            return (f'<StateTransition stateToId="{stid}" duration="180"><TransitionNumberCondition inputId="{state}" value="1"/><TransitionBoolCondition inputId="{motion}" opValue="notEqual"/></StateTransition>'
                    f'<StateTransition stateToId="{working_still[0]}" duration="0"><TransitionNumberCondition inputId="{state}" value="1"/><TransitionBoolCondition inputId="{motion}"/></StateTransition>')
        return (f'<StateTransition stateToId="{stid}" duration="180"><TransitionNumberCondition inputId="{state}" value="{i}"/><TransitionBoolCondition inputId="{motion}" opValue="notEqual"/></StateTransition>'
                f'<StateTransition stateToId="{stid}" duration="0"><TransitionNumberCondition inputId="{state}" value="{i}"/><TransitionBoolCondition inputId="{motion}"/></StateTransition>')
    out = (f'<StateMachine name="TimmyUI" id="{sm}"><StateMachineNumber name="State" value="0" id="{state}"/><StateMachineBool name="Hover" id="{hover}"/>'
           f'<StateMachineBool name="Pressed" id="{pressed}"/><StateMachineBool name="ReducedMotion" id="{motion}"/>'
           f'<StateMachineLayer name="Operation states" id="{lid}"><AnyState x="0" y="-160">' + ''.join(transitions(i, stid) for i, (stid, aid) in enumerate(states)) +
           f'</AnyState><ExitState x="1100" y="-160"/><EntryState x="0" y="0"><StateTransition stateToId="{states[0][0]}"/></EntryState>'
           + ''.join(f'<AnimationState x="{180 + i * 220}" y="0" animationId="{aid}" reset="true" id="{stid}"/>' for i, (stid, aid) in enumerate(states)))
    if working_still:
        out += f'<AnimationState x="1300" y="0" animationId="{working_still[1]}" reset="true" id="{working_still[0]}"/>'
    out += '</StateMachineLayer>'
    return out


def layer(nm, inputid, offa, ona, offs, ons):
    return (f'<StateMachineLayer name="{nm}"><AnyState x="0" y="-160"/><ExitState x="600" y="-160"/><EntryState x="0" y="0"><StateTransition stateToId="{offs}"/></EntryState>'
            f'<AnimationState x="180" y="0" animationId="{offa}" id="{offs}"><StateTransition stateToId="{ons}" duration="120"><TransitionBoolCondition inputId="{inputid}"/></StateTransition></AnimationState>'
            f'<AnimationState x="400" y="0" animationId="{ona}" id="{ons}"><StateTransition stateToId="{offs}" duration="120"><TransitionBoolCondition inputId="{inputid}" opValue="notEqual"/></StateTransition></AnimationState></StateMachineLayer>')


def build(name, w, h, kind, theme='amber', preview=False):
    """One artboard. kind: 'console' | 'card' | 'button'. preview: the Inspect view's variant (baked PREVIEW caption + click listener)."""
    art, style, sm = ident(), ident(), ident()
    state, hover, pressed, motion = ident(), ident(), ident(), ident()
    colors = THEMES[theme]
    draw = []   # bottom → top (reversed into the file: the first child draws on top)
    runs = dict(RUNS['ActionButton' if kind == 'button' else 'AgentConsole' if kind == 'console' else 'ProviderCard'])
    if preview:
        runs['Caption'] = PREVIEW_CAPTION if kind != 'button' else 'Preview action'
    # ── the panel ──
    if kind != 'button':
        draw.append(gradient_rect(w / 2, h / 2, w - 2, h - 2, [(0, RAISED), (1, SURFACE)], 'Panel', 18, BORDER)[1])
        draw.append(rect(w / 2, 2, w - 40, 1, TEXT, 'Top light', opacity=0.08)[1])
        draw.append(rect(w / 2, 56, w - 48, 1, BORDER, 'Divider')[1])
        draw.append(text(28, 20, runs['Title'], 12, MUTED, 'Title')[1])
        draw.append(text(w - 212, 21, runs['Tag'], 11, MUTED, 'Tag')[1])
        draw.append(text(28, h - 42, runs['Caption'], 10, MUTED, 'Caption')[1])
    else:
        draw.append(gradient_rect(w / 2, h / 2, w - 2, h - 2, [(0, colors['start']), (0.55, colors['soft']), (1, colors['accent'])], 'Panel', 14, colors['ink'], 'diagonal')[1])
        draw.append(rect(w / 2, 2, w - 24, 1, 'FFFFFFFF', 'Top light', opacity=0.35)[1])
        draw.append(text(22, 25, runs['Caption'], 16, colors['ink'], 'Caption', 600)[1])
    if kind == 'card':
        draw.append(text(24, 66, runs['ProviderName'], 17, TEXT, 'ProviderName', 600)[1])
        draw.append(text(24, 92, runs['ProviderState'], 12, SECONDARY, 'ProviderState')[1])
        draw.append(text(24, 110, runs['ProviderDetail'], 11, MUTED, 'ProviderDetail')[1])
    # ── the state groups ──
    groups, ring = [], None
    for i, st in enumerate(STATES):
        children = []
        if kind == 'button':
            children += button_mark(i, w - 30, h / 2, colors['ink'])
        elif kind == 'console':
            headline, line = WORDS['console'][i]
            children.append(text(28, 92, headline, 28, TEXT, f'Headline{st}', 600)[1])
            children.append(text(30, 136, line, 15, SECONDARY, f'Line{st}')[1])
            marks, rg = glyph(kind, i, w / 2, 236, True)
            children += marks
            ring = rg or ring
        else:
            headline, _ = WORDS['card'][i]
            children.append(text(24, 150, headline, 19, TEXT, f'Headline{st}', 600)[1])
            marks, rg = glyph(kind, i, w - 70, 150, False)
            children += marks
            ring = rg or ring
        gid, gmarkup = group(list(reversed(children)), st, 1 if i == 0 else 0)
        groups.append(gid)
        draw.append(gmarkup)
    # ── the preview's baked control (the Inspect view's variant only) ──
    hit = None
    if preview and kind != 'button':
        hit, markup = rect(w - 108, h - 42, 160, 40, colors['accent'], 'Inspect interaction pill', 7)
        draw.append(markup)
        draw.append(text(w - 172, h - 49, 'Inspect interaction', 11, colors['ink'], 'InspectInteraction')[1])
    if kind == 'button':
        hit = ident()
        draw.append(f'<Shape x="{w / 2}" y="{h / 2}" id="{hit}" name="Button hit area"><Rectangle width="{w - 4}" height="{h - 4}" originX="0.5" originY="0.5" cornerRadiusTL="12"/><Fill><SolidColor colorValue="01000000"/></Fill></Shape>')
    # ── hover outline and pressed wash (keyed by their layers; Hover follows the page's selection, Pressed the page's press) ──
    hoverid, hovermarkup = rect(w / 2, h / 2, w - 4, h - 4, None, 'Hover outline', 16 if kind != 'button' else 12, colors['accent'] if kind != 'button' else colors['ink'], 0, 1.5)
    pressid, pressmarkup = rect(w / 2, h / 2, w - 8, h - 8, ('22' + colors['accent'][2:]) if kind != 'button' else ('26' + colors['ink'][2:]), 'Pressed wash', 14 if kind != 'button' else 10, opacity=0)
    draw += [hovermarkup, pressmarkup]
    # ── the animations: one pose per state (the group's opacity), Working spins the ring; WorkingStill does not ──
    animations, states = [], []
    for i, st in enumerate(STATES):
        aid, stid = ident(), ident()
        keys = ''.join(key(g, 18, [(0, 1 if j == i else 0)]) for j, g in enumerate(groups))
        if i == 1 and ring:
            keys += key(ring, 15, [(0, 0), (120, 6.2831853)])
        animations.append(f'<LinearAnimation name="{st}" duration="120" fps="60" loopValue="loop" id="{aid}">{keys}</LinearAnimation>')
        states.append((stid, aid))
    still = None
    if ring:
        aid, stid = ident(), ident()
        keys = ''.join(key(g, 18, [(0, 1 if j == 1 else 0)]) for j, g in enumerate(groups)) + key(ring, 15, [(0, 0.9)])
        animations.append(f'<LinearAnimation name="WorkingStill" duration="120" fps="60" loopValue="loop" id="{aid}">{keys}</LinearAnimation>')
        still = (stid, aid)
    sm_markup = machine((sm, state, hover, pressed, motion), states, working_still=still)
    for inputid, target, nm in [(hover, hoverid, 'Hover'), (pressed, pressid, 'Pressed')]:
        offa, ona, offs, ons = ident(), ident(), ident(), ident()
        animations.append(f'<LinearAnimation name="{nm} off" duration="12" id="{offa}">{key(target, 18, [(0, 0)])}</LinearAnimation>')
        animations.append(f'<LinearAnimation name="{nm} on" duration="12" id="{ona}">{key(target, 18, [(0, 1)])}</LinearAnimation>')
        sm_markup += layer(nm, inputid, offa, ona, offs, ons)
    # the pointer listeners: the ActionButton acknowledges a pointer (Hover/Pressed only — never a state); the preview variants
    # carry the "Inspect click" listener (State → 1) the Inspect view shows; the production console and card have NO listener
    if kind == 'button':
        for event, inputid, val in [('enter', hover, 'true'), ('exit', hover, 'false'), ('down', pressed, 'true'), ('up', pressed, 'false')]:
            sm_markup += f'<StateMachineListenerSingle name="Button {event}" targetId="{hit}" listenerTypeValue="{event}"><ListenerBoolChange inputId="{inputid}" value="{val}"/></StateMachineListenerSingle>'
    if preview and hit:
        sm_markup += f'<StateMachineListenerSingle name="Inspect click" targetId="{hit}" listenerTypeValue="click"><ListenerNumberChange inputId="{state}" value="1"/></StateMachineListenerSingle>'
    sm_markup += '</StateMachine>'
    return (f'<Artboard name="{name}" id="{art}" width="{w}" height="{h}" styleId="{style}" defaultStateMachineId="{sm}"><LayoutComponentStyle id="{style}"/>'
            + ''.join(reversed(draw)) + sm_markup + ''.join(animations) + '</Artboard>'), runs


ARTBOARDS = [
    ('AgentConsole', 640, 380, 'console', 'amber', False),
    ('ProviderCard', 400, 260, 'card', 'amber', False),
    ('ActionButton', 240, 72, 'button', 'amber', False),
    ('ActionButtonGlacier', 240, 72, 'button', 'glacier', False),
    ('AgentConsolePreview', 640, 380, 'console', 'amber', True),
    ('ProviderCardPreview', 400, 260, 'card', 'amber', True),
    ('ActionButtonPreview', 240, 72, 'button', 'amber', True),
]

if __name__ == '__main__':
    markup, all_runs = [], {}
    for name, w, h, kind, theme, preview in ARTBOARDS:
        m, runs = build(name, w, h, kind, theme, preview)
        markup.append(m)
        all_runs[name] = runs
    scene = '<Rive version="1" kind="fragment">' + ''.join(markup) + f'<FontAsset file="Outfit.ttf" name="Outfit" id="{FONT}"/></Rive>'
    (p / 'scene.rml').write_text(scene)
    production = [a[0] for a in ARTBOARDS if not a[5]]
    previews = [a[0] for a in ARTBOARDS if a[5]]
    (p / 'rive.yaml').write_text(
        'name: timmy-ui\nfile: timmy-ui.riv\ncontract: 2\nartboard: AgentConsole\n'
        f'artboards: {", ".join(production)}\npreviewArtboards: {", ".join(previews)}\n'
        'stateMachine: TimmyUI\ninputs: State, Hover, Pressed, ReducedMotion\nfont: Outfit.ttf\n'
        + ''.join(f'runs.{name}: {", ".join(runs)}\n' for name, runs in all_runs.items() if name in production)
        + 'logs:\n  file: build/rive.log\n  problems: build/problems.log\n')
    print('authored', p / 'scene.rml', 'and', p / 'rive.yaml')
