'use strict';
const path  = require('path');
const React = require('react');
const { fs, util, Toggle, More, EmptyPlaceholder, Icon, Spinner, FlexLayout } = require('vortex-api');
let reactBootstrap = null;
try { reactBootstrap = require('react-bootstrap'); } catch (_) {}

const { GAME_ID }           = require('./constants');
const { getIniValue, setIniValue, getIniListValues, setIniListValues } = require('./ini');
const { findSettingsFile, ensureUserSettingsFile }  = require('./ue4ss');

// ---------------------------------------------------------------------------
// UE4SS settings page — native Vortex look (Toggle / Panel / EmptyPlaceholder)
// with graceful fallbacks when components are unavailable.
// ---------------------------------------------------------------------------

// Known option lists for selects — values not in these lists are shown as
// '<value> (manual)' so a user-edited value survives the round-trip.
const GRAPHICS_API_OPTIONS = [
  { value: 'dx11',   label: 'DirectX 11 (recommended for EMERGENCY 2023)' },
  { value: 'd3d11',  label: 'DirectX 11 (d3d11)' },
  { value: 'opengl', label: 'OpenGL' },
];

const RENDER_MODE_OPTIONS = [
  { value: 'ExternalThread',         label: 'ExternalThread (default)' },
  { value: 'EngineTick',             label: 'EngineTick' },
  { value: 'GameViewportClientTick', label: 'GameViewportClientTick' },
];

// Field → INI section/key mapping used by dirty-aware save().
const FIELD_TO_INI = {
  graphicsAPI:       { section: 'Debug', key: 'GraphicsAPI' },
  consoleEnabled:    { section: 'Debug', key: 'ConsoleEnabled' },
  guiConsoleEnabled: { section: 'Debug', key: 'GuiConsoleEnabled' },
  guiConsoleVisible: { section: 'Debug', key: 'GuiConsoleVisible' },
  renderMode:        { section: 'Debug', key: 'RenderMode' },
  modFolders:        { section: 'Overrides', key: 'ModsFolderPaths' },
};

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
      dirtyFields:      {},
      fileMtime:        null,
      loadedValues:     null,
    };
    this._unmounted = false;
    this._onFocus   = this._onFocus.bind(this);
  }

  componentDidMount() {
    this.load();
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this._onFocus);
    }
  }

  componentWillUnmount() {
    this._unmounted = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this._onFocus);
    }
  }

  _onFocus() {
    const settingsPath = this.state.settingsPath;
    if (!settingsPath) return;
    // Only reload if nothing is dirty — don't throw away user's in-progress edits.
    if (Object.keys(this.state.dirtyFields).length > 0) return;
    fs.statAsync(settingsPath).then(stat => {
      if (this._unmounted) return;
      const mtime = stat.mtime ? stat.mtime.getTime() : stat.mtimeMs;
      if (mtime !== this.state.fileMtime) {
        this.setState({ loaded: false, error: null });
        this.load();
      }
    }).catch(() => {
      // File gone — just ignore on focus
    });
  }

  load() {
    const disc = this._getDiscovery();
    if (!disc || !disc.path) {
      if (this._unmounted) return;
      this.setState({ error: 'Game not found in Vortex', loaded: true });
      return;
    }
    findSettingsFile(disc.path)
      .then(settingsPath => {
        if (this._unmounted) return;
        if (!settingsPath) { this.setState({ settingsPath: null, loaded: true }); return; }
        return fs.statAsync(settingsPath).then(stat => {
          return fs.readFileAsync(settingsPath, 'utf8').then(content => {
            if (this._unmounted) return;
            const graphicsAPI       = getIniValue(content, 'Debug', 'GraphicsAPI')        || 'dx11';
            const consoleEnabled    = (getIniValue(content, 'Debug', 'ConsoleEnabled')    || '').trim() === '1';
            const guiConsoleEnabled = (getIniValue(content, 'Debug', 'GuiConsoleEnabled') || '').trim() === '1';
            const guiConsoleVisible = (getIniValue(content, 'Debug', 'GuiConsoleVisible') || '').trim() === '1';
            const renderMode        = getIniValue(content, 'Debug', 'RenderMode')         || 'ExternalThread';
            const modFolders        = getIniListValues(content, 'Overrides', 'ModsFolderPaths');
            const mtime = stat.mtime ? stat.mtime.getTime() : stat.mtimeMs;
            const loadedValues = {
              graphicsAPI,
              consoleEnabled,
              guiConsoleEnabled,
              guiConsoleVisible,
              renderMode,
              modFolders,
            };
            this.setState({
              settingsPath,
              graphicsAPI,
              consoleEnabled,
              guiConsoleEnabled,
              guiConsoleVisible,
              renderMode,
              modFolders,
              loaded: true,
              fileMtime: mtime,
              loadedValues,
              dirtyFields: {},
            });
          });
        });
      })
      .catch(err => {
        if (this._unmounted) return;
        this.setState({ error: err.message, loaded: true });
      });
  }

  _getDiscovery() {
    const st = this.props.api && this.props.api.getState && this.props.api.getState();
    return st &&
           st.settings &&
           st.settings.gameMode &&
           st.settings.gameMode.discovered &&
           st.settings.gameMode.discovered[GAME_ID];
  }

  // Serialise a state value to the INI string value for comparison purposes.
  _fieldToIniValue(field, value) {
    if (field === 'consoleEnabled' || field === 'guiConsoleEnabled' || field === 'guiConsoleVisible') {
      return value ? '1' : '0';
    }
    return value;
  }

  save() {
    const state = this.state;
    const settingsPath = state.settingsPath;
    if (!settingsPath) return;
    const dirty = Object.keys(state.dirtyFields);
    if (dirty.length === 0) return;

    // Re-read the file fresh so we merge onto the latest on-disk content.
    fs.statAsync(settingsPath).then(freshStat => {
      const freshMtime = freshStat.mtime ? freshStat.mtime.getTime() : freshStat.mtimeMs;
      const mtimeChanged = (freshMtime !== state.fileMtime);

      return fs.readFileAsync(settingsPath, 'utf8').then(content => {
        // If mtime changed, check for real conflicts on dirty fields.
        const conflictingFields = [];
        if (mtimeChanged && state.loadedValues) {
          for (let i = 0; i < dirty.length; i++) {
            const field = dirty[i];
            if (field === 'modFolders') {
              // Compare list values from file vs what was loaded
              const fileListVals = getIniListValues(content, FIELD_TO_INI[field].section, FIELD_TO_INI[field].key);
              const loadedListVals = state.loadedValues[field] || [];
              const filesJoined = fileListVals.slice().sort().join('\0');
              const loadedJoined = loadedListVals.slice().sort().join('\0');
              if (filesJoined !== loadedJoined) {
                conflictingFields.push(field);
              }
            } else {
              const fileVal = (getIniValue(content, FIELD_TO_INI[field].section, FIELD_TO_INI[field].key) || '').trim();
              const loadedRaw = this._fieldToIniValue(field, state.loadedValues[field]);
              const normalizedLoaded = (loadedRaw === null || loadedRaw === undefined) ? '' : String(loadedRaw).trim();
              if (fileVal !== normalizedLoaded) {
                conflictingFields.push(field);
              }
            }
          }
        }

        const doMerge = (iniContent) => {
          let updated = iniContent;
          for (let j = 0; j < dirty.length; j++) {
            const f = dirty[j];
            if (f === 'modFolders') {
              updated = setIniListValues(updated, 'Overrides', 'ModsFolderPaths', state.modFolders);
            } else if (f === 'consoleEnabled') {
              updated = setIniValue(updated, 'Debug', 'ConsoleEnabled', state.consoleEnabled ? '1' : '0');
            } else if (f === 'guiConsoleEnabled') {
              updated = setIniValue(updated, 'Debug', 'GuiConsoleEnabled', state.guiConsoleEnabled ? '1' : '0');
            } else if (f === 'guiConsoleVisible') {
              updated = setIniValue(updated, 'Debug', 'GuiConsoleVisible', state.guiConsoleVisible ? '1' : '0');
            } else if (FIELD_TO_INI[f]) {
              updated = setIniValue(updated, FIELD_TO_INI[f].section, FIELD_TO_INI[f].key, state[f]);
            }
          }
          return fs.writeFileAsync(settingsPath, updated, 'utf8')
            .then(() => {
              return fs.statAsync(settingsPath).then(newStat => {
                const newMtime = newStat.mtime ? newStat.mtime.getTime() : newStat.mtimeMs;
                const newLoadedValues = { ...state.loadedValues };
                for (let k = 0; k < dirty.length; k++) {
                  const df = dirty[k];
                  newLoadedValues[df] = state[df];
                }
                if (this._unmounted) return;
                this.setState({ dirtyFields: {}, fileMtime: newMtime, loadedValues: newLoadedValues });
                if (this.props.api && this.props.api.sendNotification) {
                  this.props.api.sendNotification({
                    id: 'ue4ss-settings-saved', type: 'success', title: 'UE4SS settings saved',
                  });
                }
              });
            });
        };

        if (conflictingFields.length === 0) {
          // No real conflict (or no mtime change): safe to merge
          return doMerge(content);
        }

        // Real conflict — ask user what to do.
        const api = this.props.api;
        if (!api || typeof api.showDialog !== 'function') {
          // No dialog API — default to keeping user's changes.
          return doMerge(content);
        }

        const conflictText = 'The following settings were changed both in Vortex and directly in the file:\n  ' +
          conflictingFields.join(', ') +
          '\n\nChoose how to proceed:';

        return api.showDialog(
          'question',
          'Settings file changed outside Vortex',
          { text: conflictText },
          [{ label: 'Reload file' }, { label: 'Keep my changes' }]
        ).then(result => {
          if (!result || result.action === 'Reload file') {
            // Abandon save, reload from disk.
            if (this._unmounted) return;
            this.setState({ loaded: false, error: null, dirtyFields: {} });
            this.load();
            return;
          }
          // 'Keep my changes' → merge anyway
          return doMerge(content);
        });
      });
    }).catch(err => {
      if (this._unmounted) return;
      this.setState({ error: err.message });
    });
  }

  render() {
    const { Button, Panel, ListGroup, ListGroupItem, FormGroup, ControlLabel, FormControl } = reactBootstrap || {};
    const {
      settingsPath, graphicsAPI, consoleEnabled, guiConsoleEnabled, guiConsoleVisible,
      renderMode, modFolders, newFolder, loaded, error, dirtyFields,
    } = this.state;
    const isDirty = Object.keys(dirtyFields).length > 0;
    const ce = React.createElement;

    // ── Refresh button ───────────────────────────────────────────────────────
    const refreshBtn = Button ? ce(Button, {
      onClick: () => { this.setState({ loaded: false, error: null }); this.load(); },
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
    if (!settingsPath) {
      const createSettingsBtn = Button ? ce(Button, {
        onClick: () => {
          const disc = this._getDiscovery();
          if (!disc || !disc.path) return;
          ensureUserSettingsFile(disc.path).then(result => {
            if (this._unmounted) return;
            if (!result) {
              this.setState({ error: 'No UE4SS template found — install UE4SS first.' });
              return;
            }
            this.setState({ loaded: false, error: null });
            this.load();
          }).catch(err => {
            if (this._unmounted) return;
            this.setState({ error: err.message });
          });
        },
      }, 'Create settings file') : null;

      return ce('div', null,
        EmptyPlaceholder ? ce(EmptyPlaceholder, {
          icon: 'mods', text: 'UE4SS settings file not found',
          subtext: 'Install a UE4SS mod first, then use Refresh or Create settings file.',
        }) : null,
        'UE4SS is not installed yet, or the settings file has not been created. Install a UE4SS mod first, then click Refresh.',
        ' ', refreshBtn,
        ' ', createSettingsBtn,
      );
    }

    // ── QoL open/edit buttons ────────────────────────────────────────────────
    const hasOpn = Button && typeof util.opn === 'function';
    const openFolderBtn = hasOpn ? ce(Button, {
      onClick: () => { util.opn(path.dirname(settingsPath)).catch(() => null); },
    },
      Icon ? ce(Icon, { name: 'folder' }) : null,
      ' Open folder',
    ) : null;
    const editFileBtn = hasOpn ? ce(Button, {
      onClick: () => { util.opn(settingsPath).catch(() => null); },
    },
      Icon ? ce(Icon, { name: 'edit' }) : null,
      ' Edit file',
    ) : null;

    // ── Panel helper ─────────────────────────────────────────────────────────
    const hasPanel = Panel && Panel.Heading && Panel.Body;
    const mkPanel = (title, panelStyle, ...children) => {
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
      const moreChild = More && moreId
        ? ce('span', { style: { verticalAlign: 'middle', marginLeft: '4px' } },
            ce(More, { id: moreId, name: label }, moreHelp))
        : null;
      const control = Toggle
        ? ce(Toggle, { checked: checked, onToggle: (v) => { onChange(v); } }, label, moreChild)
        : FormControl
          ? ce('span', null,
              ce(FormControl, {
                componentClass: 'select',
                value: checked ? '1' : '0',
                onChange: (e) => { onChange(e.target.value === '1'); },
              },
                ce('option', { value: '1' }, 'Enabled'),
                ce('option', { value: '0' }, 'Disabled'),
              ),
              moreChild,
            )
          : null;
      return FormGroup
        ? ce(FormGroup, { style: { marginBottom: '12px' } },
            ControlLabel && !Toggle ? ce(ControlLabel, null, label) : null,
            control,
          )
        : ce('div', { style: { marginBottom: '12px' } }, control);
    };

    // ── Build select options with unknown-value fallback ─────────────────────
    const buildOptions = (options, currentValue) => {
      const known = options.some(o => o.value === currentValue);
      const opts = known ? options : [{ value: currentValue, label: currentValue + ' (manual)' }].concat(options);
      return opts.map(o => ce('option', { value: o.value, key: o.value }, o.label));
    };

    // ── Panel: Rendering ─────────────────────────────────────────────────────
    const renderingPanel = mkPanel('Rendering', null,
      FormGroup ? ce(FormGroup, { style: { marginBottom: '12px' } },
        ControlLabel ? ce(ControlLabel, { style: { marginBottom: 0 } }, 'Graphics API',
          More ? ce('span', { style: { verticalAlign: 'middle', marginLeft: '4px' } },
            ce(More, { id: 'ue4ss-graphics-api', name: 'Graphics API' },
              'EMERGENCY 2023 requires dx11; opengl causes a black screen.'),
          ) : null,
        ) : null,
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: graphicsAPI,
          onChange: (e) => { this.setState(s => { const d = { ...s.dirtyFields }; d['graphicsAPI'] = true; return { graphicsAPI: e.target.value, dirtyFields: d }; }); },
        }, ...buildOptions(GRAPHICS_API_OPTIONS, graphicsAPI)) : null,
      ) : null,
      FormGroup ? ce(FormGroup, { style: { marginBottom: '12px' } },
        ControlLabel ? ce(ControlLabel, null, 'Render Mode') : null,
        FormControl ? ce(FormControl, {
          componentClass: 'select',
          value: renderMode,
          onChange: (e) => { this.setState(s => { const d = { ...s.dirtyFields }; d['renderMode'] = true; return { renderMode: e.target.value, dirtyFields: d }; }); },
        }, ...buildOptions(RENDER_MODE_OPTIONS, renderMode)) : null,
      ) : null,
    );

    // ── Panel: Debug console ─────────────────────────────────────────────────
    const debugPanel = mkPanel('Debug console', { marginTop: '8px' },
      mkToggle('Console', consoleEnabled,
        (v) => { this.setState(s => { const d = { ...s.dirtyFields }; d['consoleEnabled'] = true; return { consoleEnabled: v, dirtyFields: d }; }); }),
      mkToggle('GUI Console', guiConsoleEnabled,
        (v) => { this.setState(s => { const d = { ...s.dirtyFields }; d['guiConsoleEnabled'] = true; return { guiConsoleEnabled: v, dirtyFields: d }; }); },
        'ue4ss-gui-console', 'Shows the in-game UE4SS debug GUI console window. The installer disables it by default.'),
      mkToggle('GUI Console Visible', guiConsoleVisible,
        (v) => { this.setState(s => { const d = { ...s.dirtyFields }; d['guiConsoleVisible'] = true; return { guiConsoleVisible: v, dirtyFields: d }; }); }),
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
                  onClick: () => {
                    this.setState(s => {
                      const d = { ...s.dirtyFields }; d['modFolders'] = true;
                      return { modFolders: s.modFolders.filter((_, i) => i !== idx), dirtyFields: d };
                    });
                  },
                },
                  Icon ? ce(Icon, { name: 'remove' }) : '×',
                ) : null,
              )
            )
          )
        : ce('div', { style: { marginBottom: '8px' } },
            ...modFolders.map((folder, idx) =>
              ce('div', { key: String(idx) },
                ce('span', null, folder),
                Button ? ce(Button, {
                  bsSize: 'xsmall',
                  style: { marginLeft: '8px' },
                  onClick: () => {
                    this.setState(s => {
                      const d = { ...s.dirtyFields }; d['modFolders'] = true;
                      return { modFolders: s.modFolders.filter((_, i) => i !== idx), dirtyFields: d };
                    });
                  },
                }, '×') : null,
              )
            )
          );

    const addRow = ce('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' } },
      ce('input', {
        type: 'text', value: newFolder,
        style: { flex: '1 1 auto', minWidth: 0 },
        onChange: (e) => { this.setState({ newFolder: e.target.value }); },
        placeholder: '../SharedMods',
      }),
      Button ? ce(Button, {
        onClick: () => {
          const trimmed = newFolder.replace(/[\r\n]+/g, '').trim();
          if (trimmed) this.setState(s => {
            const d = { ...s.dirtyFields }; d['modFolders'] = true;
            return { modFolders: s.modFolders.concat([trimmed]), newFolder: '', dirtyFields: d };
          });
        },
      },
        Icon ? ce(Icon, { name: 'add' }) : null,
        ' Add',
      ) : null,
      Button && typeof this.props.api.selectDir === 'function' ? ce(Button, {
        onClick: () => {
          this.props.api.selectDir({ title: 'Select a UE4SS mods folder' })
            .then(p => {
              if (p) this.setState(s => {
                const d = { ...s.dirtyFields }; d['modFolders'] = true;
                return { modFolders: s.modFolders.concat([p]), dirtyFields: d };
              });
            })
            .catch(() => null);
        },
      }, 'Browse…') : null,
    );

    const foldersPanel = mkPanel('External mod folders (UE4SS +ModsFolderPaths)', { marginTop: '8px' },
      folderEntries,
      addRow,
    );

    // ── Toolbar ──────────────────────────────────────────────────────────────
    const saveBtn = Button ? ce(Button, {
      bsStyle:  'primary',
      onClick:  () => { this.save(); },
      disabled: !isDirty || !loaded,
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
