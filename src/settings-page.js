'use strict';
const path  = require('path');
const React = require('react');
const { fs, util, Toggle, More, EmptyPlaceholder, Icon, Spinner, FlexLayout } = require('vortex-api');
let reactBootstrap = null;
try { reactBootstrap = require('react-bootstrap'); } catch (_) {}

const { GAME_ID }           = require('./constants');
const { getIniValue, setIniValue, getIniListValues, setIniListValues } = require('./ini');
const { findSettingsFile }  = require('./ue4ss');

// ---------------------------------------------------------------------------
// UE4SS settings page — native Vortex look (Toggle / Panel / EmptyPlaceholder)
// with graceful fallbacks when components are unavailable.
// ---------------------------------------------------------------------------

class UE4SSSettingsPage extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      settingsPath:     null,
      graphicsAPI:      'dx11',
      consoleEnabled:   false,
      guiConsoleEnabled: false,
      guiConsoleVisible: false,
      renderMode:       'ExternalThread',
      modFolders:       [],
      newFolder:        '',
      loaded:           false,
      error:            null,
      dirty:            false,
    };
  }

  componentDidMount() { this.load(); }

  load() {
    const disc = this._getDiscovery();
    if (!disc || !disc.path) {
      this.setState({ error: 'Game not found in Vortex', loaded: true });
      return;
    }
    findSettingsFile(disc.path)
      .then(settingsPath => {
        if (!settingsPath) { this.setState({ settingsPath: null, loaded: true }); return; }
        return fs.readFileAsync(settingsPath, 'utf8').then(content => {
          const graphicsAPI       = getIniValue(content, 'Debug', 'GraphicsAPI')        || 'dx11';
          const consoleEnabled    = (getIniValue(content, 'Debug', 'ConsoleEnabled')    || '').trim() === '1';
          const guiConsoleEnabled = (getIniValue(content, 'Debug', 'GuiConsoleEnabled') || '').trim() === '1';
          const guiConsoleVisible = (getIniValue(content, 'Debug', 'GuiConsoleVisible') || '').trim() === '1';
          const renderMode        = getIniValue(content, 'Debug', 'RenderMode')         || 'ExternalThread';
          const modFolders        = getIniListValues(content, 'Overrides', 'ModsFolderPaths');
          this.setState({ settingsPath, graphicsAPI, consoleEnabled, guiConsoleEnabled, guiConsoleVisible, renderMode, modFolders, loaded: true });
        });
      })
      .catch(err => this.setState({ error: err.message, loaded: true }));
  }

  _getDiscovery() {
    const st = this.props.api && this.props.api.getState && this.props.api.getState();
    return st &&
           st.settings &&
           st.settings.gameMode &&
           st.settings.gameMode.discovered &&
           st.settings.gameMode.discovered[GAME_ID];
  }

  save() {
    const { settingsPath, graphicsAPI, consoleEnabled, guiConsoleEnabled, guiConsoleVisible, renderMode, modFolders } = this.state;
    if (!settingsPath) return;
    fs.readFileAsync(settingsPath, 'utf8')
      .then(content => {
        let updated = setIniValue(content, 'Debug', 'GraphicsAPI',      graphicsAPI);
        updated     = setIniValue(updated,  'Debug', 'ConsoleEnabled',    consoleEnabled    ? '1' : '0');
        updated     = setIniValue(updated,  'Debug', 'GuiConsoleEnabled', guiConsoleEnabled ? '1' : '0');
        updated     = setIniValue(updated,  'Debug', 'GuiConsoleVisible', guiConsoleVisible ? '1' : '0');
        updated     = setIniValue(updated,  'Debug', 'RenderMode',        renderMode);
        updated     = setIniListValues(updated, 'Overrides', 'ModsFolderPaths', modFolders);
        return fs.writeFileAsync(settingsPath, updated, 'utf8');
      })
      .then(() => {
        if (this.props.api && this.props.api.sendNotification) {
          this.props.api.sendNotification({
            id: 'ue4ss-settings-saved', type: 'success', title: 'UE4SS settings saved',
          });
        }
        this.setState({ dirty: false });
      })
      .catch(err => this.setState({ error: err.message }));
  }

  render() {
    const rbs = reactBootstrap || {};
    const { Button, Panel, ListGroup, ListGroupItem, FormGroup, ControlLabel, FormControl } = rbs;
    const { settingsPath, graphicsAPI, consoleEnabled, guiConsoleEnabled, guiConsoleVisible,
            renderMode, modFolders, newFolder, loaded, error, dirty } = this.state;
    const ce = React.createElement;

    // ── Refresh button ───────────────────────────────────────────────────────
    const refreshBtn = Button ? ce(Button, {
      onClick: () => this.setState({ loaded: false, error: null }, () => this.load()),
    },
      Icon ? ce(Icon, { name: 'refresh' }) : null,
      ' Refresh',
    ) : null;

    // ── Loading ──────────────────────────────────────────────────────────────
    if (!loaded) return ce('div', null,
      Spinner ? ce(Spinner) : null,
      ' Loading UE4SS settings…',
    );

    // ── Error ────────────────────────────────────────────────────────────────
    if (error) return ce('div', null,
      EmptyPlaceholder ? ce(EmptyPlaceholder, {
        icon: 'feedback-error', text: "Couldn't load UE4SS settings", subtext: error,
      }) : null,
      'Error: ' + error,
      ' ', refreshBtn,
    );

    // ── Not installed ────────────────────────────────────────────────────────
    if (!settingsPath) return ce('div', null,
      EmptyPlaceholder ? ce(EmptyPlaceholder, {
        icon: 'mods', text: 'UE4SS is not installed yet',
        subtext: 'Install a UE4SS mod first, then click Refresh.',
      }) : null,
      'UE4SS is not installed yet. Install a UE4SS mod first, then click Refresh.',
      ' ', refreshBtn,
    );

    // ── QoL open/edit buttons ────────────────────────────────────────────────
    const hasOpn = Button && typeof util.opn === 'function';
    const openFolderBtn = hasOpn ? ce(Button, {
      onClick: () => util.opn(path.dirname(settingsPath)).catch(() => null),
    },
      Icon ? ce(Icon, { name: 'folder' }) : null,
      ' Open folder',
    ) : null;
    const editFileBtn = hasOpn ? ce(Button, {
      onClick: () => util.opn(settingsPath).catch(() => null),
    },
      Icon ? ce(Icon, { name: 'edit' }) : null,
      ' Edit file',
    ) : null;

    // ── Panel helper ─────────────────────────────────────────────────────────
    const hasPanel = Panel && Panel.Heading && Panel.Body;
    const mkPanel  = (title, panelStyle, ...children) => {
      const ps = panelStyle || {};
      if (hasPanel) {
        return ce(Panel, { style: ps },
          ce(Panel.Heading, null, ce('h3', { className: 'panel-title' }, title)),
          ce(Panel.Body, null, ...children),
        );
      }
      return ce('div', { className: 'settings-group', style: ps },
        ce('div', { className: 'settings-group__header' }, title),
        ...children,
      );
    };

    // ── Toggle helper (falls back to FormControl select) ─────────────────────
    const mkToggle = (label, checked, onChange, moreId, moreHelp) => {
      const control = Toggle
        ? ce(Toggle, { checked, onToggle: (v) => onChange(v) }, label)
        : FormControl
          ? ce(FormControl, {
              componentClass: 'select',
              value: checked ? '1' : '0',
              onChange: (e) => onChange(e.target.value === '1'),
            },
              ce('option', { value: '1' }, 'Enabled'),
              ce('option', { value: '0' }, 'Disabled'),
            )
          : null;
      const help = More && moreId ? ce(More, { id: moreId, name: label }, moreHelp) : null;
      // Inline row: [control] [ⓘ] on the same line, vertically centered
      const helpSpan = help
        ? ce('span', { style: { display: 'inline-flex', alignItems: 'center', lineHeight: 1 } }, help)
        : null;
      const row = helpSpan
        ? ce('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, control, helpSpan)
        : control;
      return FormGroup
        ? ce(FormGroup, { style: { marginBottom: '12px' } },
            ControlLabel && !Toggle ? ce(ControlLabel, null, label) : null,
            row,
          )
        : ce('div', { style: { marginBottom: '12px' } }, row);
    };

    // ── Panel: Rendering ─────────────────────────────────────────────────────
    const renderingPanel = mkPanel('Rendering', null,
      FormGroup ? ce(FormGroup, { style: { marginBottom: '12px' } },
        ce('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          ControlLabel ? ce(ControlLabel, { style: { marginBottom: 0 } }, 'Graphics API') : null,
          More ? ce('span', { style: { display: 'inline-flex', alignItems: 'center', lineHeight: 1 } },
            ce(More, { id: 'ue4ss-graphics-api', name: 'Graphics API' },
              'EMERGENCY 2023 requires dx11; opengl causes a black screen.'),
          ) : null,
        ),
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: graphicsAPI,
          onChange: (e) => this.setState({ graphicsAPI: e.target.value, dirty: true }),
        },
          ce('option', { value: 'dx11' },   'DirectX 11 (recommended for EMERGENCY 2023)'),
          ce('option', { value: 'd3d11' },  'DirectX 11 (d3d11)'),
          ce('option', { value: 'opengl' }, 'OpenGL'),
        ) : null,
      ) : null,
      FormGroup ? ce(FormGroup, { style: { marginBottom: '12px' } },
        ControlLabel ? ce(ControlLabel, null, 'Render Mode') : null,
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: renderMode,
          onChange: (e) => this.setState({ renderMode: e.target.value, dirty: true }),
        },
          ce('option', { value: 'ExternalThread' },         'ExternalThread (default)'),
          ce('option', { value: 'EngineTick' },             'EngineTick'),
          ce('option', { value: 'GameViewportClientTick' }, 'GameViewportClientTick'),
        ) : null,
      ) : null,
    );

    // ── Panel: Debug console ─────────────────────────────────────────────────
    const debugPanel = mkPanel('Debug console', { marginTop: '8px' },
      mkToggle('Console', consoleEnabled,
        (v) => this.setState({ consoleEnabled: v, dirty: true })),
      mkToggle('GUI Console', guiConsoleEnabled,
        (v) => this.setState({ guiConsoleEnabled: v, dirty: true }),
        'ue4ss-gui-console', 'Hides the in-game UE4SS debug console window.'),
      mkToggle('GUI Console Visible', guiConsoleVisible,
        (v) => this.setState({ guiConsoleVisible: v, dirty: true })),
    );

    // ── Panel: External mod folders ──────────────────────────────────────────
    const folderEntries = modFolders.length === 0
      ? ce('div', { className: 'muted', style: { marginBottom: '8px', opacity: 0.7 } }, 'No external folders.')
      : ListGroup
        ? ce(ListGroup, { style: { marginBottom: '8px' } },
            ...modFolders.map((folder, idx) =>
              ce(ListGroupItem, { key: String(idx) },
                ce('span', null, folder),
                Button ? ce(Button, {
                  bsSize: 'xsmall',
                  style: { marginLeft: '8px' },
                  onClick: () => this.setState(s => ({
                    modFolders: s.modFolders.filter((_, i) => i !== idx),
                    dirty: true,
                  })),
                },
                  Icon ? ce(Icon, { name: 'remove' }) : '×',
                ) : null,
              ),
            ),
          )
        : ce('div', { style: { marginBottom: '8px' } },
            ...modFolders.map((folder, idx) =>
              ce('div', { key: String(idx) },
                ce('span', null, folder),
                Button ? ce(Button, {
                  bsSize: 'xsmall',
                  style: { marginLeft: '8px' },
                  onClick: () => this.setState(s => ({
                    modFolders: s.modFolders.filter((_, i) => i !== idx),
                    dirty: true,
                  })),
                }, '×') : null,
              ),
            ),
          );

    const addRow = ce('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' } },
      ce('input', {
        type: 'text', value: newFolder,
        style: { flex: '1 1 auto', minWidth: 0 },
        onChange: (e) => this.setState({ newFolder: e.target.value }),
        placeholder: '../SharedMods',
      }),
      Button ? ce(Button, {
        onClick: () => {
          const trimmed = newFolder.trim();
          if (trimmed) this.setState(s => ({ modFolders: [...s.modFolders, trimmed], newFolder: '', dirty: true }));
        },
      },
        Icon ? ce(Icon, { name: 'add' }) : null,
        ' Add',
      ) : null,
      Button && typeof this.props.api.selectDir === 'function' ? ce(Button, {
        onClick: () => this.props.api.selectDir({ title: 'Select a UE4SS mods folder' })
          .then(p => { if (p) this.setState({ modFolders: this.state.modFolders.concat(p), dirty: true }); })
          .catch(() => null),
      }, 'Browse…') : null,
    );

    const foldersPanel = mkPanel('External mod folders (UE4SS +ModsFolderPaths)', { marginTop: '8px' },
      folderEntries,
      addRow,
    );

    // ── Toolbar ──────────────────────────────────────────────────────────────
    const saveBtn = Button ? ce(Button, {
      bsStyle:  'primary',
      onClick:  () => this.save(),
      disabled: !dirty || !loaded,
    },
      Icon ? ce(Icon, { name: 'save' }) : null,
      ' Save',
    ) : null;

    return ce('div', null,
      renderingPanel,
      debugPanel,
      foldersPanel,
      ce('div', { className: 'btn-toolbar', style: { marginTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        saveBtn, refreshBtn, openFolderBtn, editFileBtn,
      ),
    );
  }
}

module.exports = UE4SSSettingsPage;
