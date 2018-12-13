/* eslint camelcase: 0 */
import React from 'react';
import PropTypes from 'prop-types';
import { bindActionCreators } from 'redux';
import { connect } from 'react-redux';
import { Shortcuts, ShortcutManager } from 'react-shortcuts';

import ExploreChartPanel from './ExploreChartPanel';
import ControlPanelsContainer from './ControlPanelsContainer';
import SaveModal from './SaveModal';
import QueryAndSaveBtns from './QueryAndSaveBtns';
import { getExploreUrlAndPayload, getExploreLongUrl } from '../exploreUtils';
import { areObjectsEqual } from '../../reduxUtils';
import { getFormDataFromControls } from '../store';
import { chartPropShape } from '../../dashboard/util/propShapes';
import * as exploreActions from '../actions/exploreActions';
import * as saveModalActions from '../actions/saveModalActions';
import * as chartActions from '../../chart/chartAction';
import { fetchDatasourceMetadata } from '../../dashboard/actions/datasources';
import { Logger, ActionLog, EXPLORE_EVENT_NAMES, LOG_ACTIONS_MOUNT_EXPLORER } from '../../logger';


// todo(hugh): Move this util.js for as a more functional switch cases
// https://codeburst.io/alternative-to-javascripts-switch-statement-with-a-functional-twist-3f572787ba1c
const matched = x => ({
  on: () => matched(x),
  otherwise: () => x,
});

const match = x => ({
  on: (pred, fn) => (pred(x) ? matched(fn(x)) : match(x)),
  otherwise: fn => console.log('default...'),
});


const keymap = {
  BOX: {
    MOVE_LEFT: ['left', 'a'],
    MOVE_RIGHT: ['right', 'd'],
    MOVE_UP: ['up', 'w'],
    MOVE_DOWN: ['down', 's'],
  },
  EXPLORE: {
    RUN: ['command+enter'],
    SAVE: ['command+shift'],
  },
};

const shortcutManager = new ShortcutManager(keymap)

const propTypes = {
  actions: PropTypes.object.isRequired,
  datasource_type: PropTypes.string.isRequired,
  isDatasourceMetaLoading: PropTypes.bool.isRequired,
  chart: chartPropShape.isRequired,
  slice: PropTypes.object,
  controls: PropTypes.object.isRequired,
  forcedHeight: PropTypes.string,
  form_data: PropTypes.object.isRequired,
  standalone: PropTypes.bool.isRequired,
  timeout: PropTypes.number,
  impressionId: PropTypes.string,
};

class ExploreViewContainer extends React.Component {
  constructor(props) {
    super(props);
    this.loadingLog = new ActionLog({
      impressionId: props.impressionId,
      source: 'slice',
      sourceId: props.slice ? props.slice.slice_id : 0,
      eventNames: EXPLORE_EVENT_NAMES,
    });
    Logger.start(this.loadingLog);

    this.state = {
      height: this.getHeight(),
      width: this.getWidth(),
      showModal: false,
      chartIsStale: false,
      refreshOverlayVisible: false,
    };

    this.addHistory = this.addHistory.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handlePopstate = this.handlePopstate.bind(this);
    this.onStop = this.onStop.bind(this);
    this.onQuery = this.onQuery.bind(this);
    this.toggleModal = this.toggleModal.bind(this);
    this.handleShortcuts = this.handleShortcuts.bind(this);
  }

  getChildContext() {
    return { shortcuts: shortcutManager }
  }

  handleShortcuts(action, event) {
    match(action)
    .on(action => action === 'RUN', () => this.onQuery())
    .on(action => action === 'SAVE', () => {
      console.log(this.props.slice);
      const sliceParams = {
        action: "overwrite",
        slice_id: this.props.slice.slice_id,
        slice_name: this.props.slice.slice_name,
        add_to_dash: "noSave",
        goto_dash: false
      };
      this.props.actions.saveSlice(this.props.form_data, sliceParams).then(({ data }) => {
        window.location = data.slice.slice_url;
      });
    })
  }

  componentDidMount() {
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('popstate', this.handlePopstate);
    this.addHistory({ isReplace: true });
    Logger.append(LOG_ACTIONS_MOUNT_EXPLORER);
  }

  componentWillReceiveProps(nextProps) {
    const wasRendered =
      ['rendered', 'failed', 'stopped'].indexOf(this.props.chart.chartStatus) > -1;
    const isRendered = ['rendered', 'failed', 'stopped'].indexOf(nextProps.chart.chartStatus) > -1;
    if (!wasRendered && isRendered) {
      Logger.send(this.loadingLog);
    }
    if (nextProps.controls.viz_type.value !== this.props.controls.viz_type.value) {
      this.props.actions.resetControls();
      this.props.actions.triggerQuery(true, this.props.chart.id);
    }
    if (
      nextProps.controls.datasource &&
      (this.props.controls.datasource == null ||
        nextProps.controls.datasource.value !== this.props.controls.datasource.value)
    ) {
      fetchDatasourceMetadata(nextProps.form_data.datasource, true);
    }

    const changedControlKeys = this.findChangedControlKeys(this.props.controls, nextProps.controls);
    if (this.hasDisplayControlChanged(changedControlKeys, nextProps.controls)) {
      this.props.actions.updateQueryFormData(
        getFormDataFromControls(nextProps.controls),
        this.props.chart.id,
      );
      this.props.actions.renderTriggered(new Date().getTime(), this.props.chart.id);
    }
    if (this.hasQueryControlChanged(changedControlKeys, nextProps.controls)) {
      this.setState({ chartIsStale: true, refreshOverlayVisible: true });
    }
  }

  /* eslint no-unused-vars: 0 */
  componentDidUpdate(prevProps, prevState) {
    this.triggerQueryIfNeeded();

    const changedControlKeys = this.findChangedControlKeys(prevProps.controls, this.props.controls);
    if (this.hasDisplayControlChanged(changedControlKeys, this.props.controls)) {
      this.addHistory({});
    }
  }

  componentWillUnmount() {
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('popstate', this.handlePopstate);
  }

  onQuery() {
    // remove alerts when query
    this.props.actions.removeControlPanelAlert();
    this.props.actions.triggerQuery(true, this.props.chart.id);

    this.setState({ chartIsStale: false, refreshOverlayVisible: false });
    this.addHistory({});
  }

  onStop() {
    if (this.props.chart && this.props.chart.queryController) {
      this.props.chart.queryController.abort();
    }
  }

  getWidth() {
    return `${window.innerWidth}px`;
  }

  getHeight() {
    if (this.props.forcedHeight) {
      return this.props.forcedHeight + 'px';
    }
    const navHeight = this.props.standalone ? 0 : 90;
    return `${window.innerHeight - navHeight}px`;
  }

  findChangedControlKeys(prevControls, currentControls) {
    return Object.keys(currentControls).filter(
      key =>
        typeof prevControls[key] !== 'undefined' &&
        !areObjectsEqual(currentControls[key].value, prevControls[key].value),
    );
  }

  hasDisplayControlChanged(changedControlKeys, currentControls) {
    return changedControlKeys.some(key => currentControls[key].renderTrigger);
  }

  hasQueryControlChanged(changedControlKeys, currentControls) {
    return changedControlKeys.some(
      key => !currentControls[key].renderTrigger && !currentControls[key].dontRefreshOnChange,
    );
  }

  triggerQueryIfNeeded() {
    if (this.props.chart.triggerQuery && !this.hasErrors()) {
      this.props.actions.runQuery(
        this.props.form_data,
        false,
        this.props.timeout,
        this.props.chart.id,
      );
    }
  }

  addHistory({ isReplace = false, title }) {
    const { payload } = getExploreUrlAndPayload({ formData: this.props.form_data });
    const longUrl = getExploreLongUrl(this.props.form_data);
    try {
      if (isReplace) {
        history.replaceState(payload, title, longUrl);
      } else {
        history.pushState(payload, title, longUrl);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Failed at altering browser history', payload, title, longUrl);
    }

    // it seems some browsers don't support pushState title attribute
    if (title) {
      document.title = title;
    }
  }

  handleResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.setState({ height: this.getHeight(), width: this.getWidth() });
    }, 250);
  }

  handlePopstate() {
    const formData = history.state;
    if (formData && Object.keys(formData).length) {
      this.props.actions.setExploreControls(formData);
      this.props.actions.runQuery(formData, false, this.props.timeout, this.props.chart.id);
    }
  }

  toggleModal() {
    this.setState({ showModal: !this.state.showModal });
  }
  hasErrors() {
    const ctrls = this.props.controls;
    return Object.keys(ctrls).some(
      k => ctrls[k].validationErrors && ctrls[k].validationErrors.length > 0,
    );
  }
  renderErrorMessage() {
    // Returns an error message as a node if any errors are in the store
    const errors = [];
    for (const controlName in this.props.controls) {
      const control = this.props.controls[controlName];
      if (control.validationErrors && control.validationErrors.length > 0) {
        errors.push(
          <div key={controlName}>
            <strong>{`[ ${control.label} ] `}</strong>
            {control.validationErrors.join('. ')}
          </div>,
        );
      }
    }
    let errorMessage;
    if (errors.length > 0) {
      errorMessage = <div style={{ textAlign: 'left' }}>{errors}</div>;
    }
    return errorMessage;
  }
  renderChartContainer() {
    return (
      <ExploreChartPanel
        width={this.state.width}
        height={this.state.height}
        {...this.props}
        errorMessage={this.renderErrorMessage()}
        refreshOverlayVisible={this.state.refreshOverlayVisible}
        addHistory={this.addHistory}
        onQuery={this.onQuery.bind(this)}
      />
    );
  }

  render() {
    if (this.props.standalone) {
      return this.renderChartContainer();
    }
    return (
      <Shortcuts
        name='EXPLORE'
        handler={this.handleShortcuts}
      >
      <div
        id="explore-container"
        className="container-fluid"
        style={{
          height: this.state.height,
          overflow: 'hidden',
        }}
      >
        {this.state.showModal && (
          <SaveModal
            onHide={this.toggleModal}
            actions={this.props.actions}
            form_data={this.props.form_data}
          />
        )}
        <div className="row">
          <div className="col-sm-4">
            <QueryAndSaveBtns
              canAdd="True"
              onQuery={this.onQuery}
              onSave={this.toggleModal}
              onStop={this.onStop}
              loading={this.props.chart.chartStatus === 'loading'}
              chartIsStale={this.state.chartIsStale}
              errorMessage={this.renderErrorMessage()}
              datasourceType={this.props.datasource_type}
            />
            <br />
            <ControlPanelsContainer
              actions={this.props.actions}
              form_data={this.props.form_data}
              controls={this.props.controls}
              datasource_type={this.props.datasource_type}
              isDatasourceMetaLoading={this.props.isDatasourceMetaLoading}
            />
          </div>
          <div className="col-sm-8">{this.renderChartContainer()}</div>
        </div>
      </div>
      </Shortcuts>
    );
  }
}

ExploreViewContainer.propTypes = propTypes;
ExploreViewContainer.childContextTypes = {
  shortcuts: PropTypes.object.isRequired
}

function mapStateToProps(state) {
  const { explore, charts, impressionId } = state;
  const form_data = getFormDataFromControls(explore.controls);
  const chartKey = Object.keys(charts)[0];
  const chart = charts[chartKey];
  return {
    isDatasourceMetaLoading: explore.isDatasourceMetaLoading,
    datasource: explore.datasource,
    datasource_type: explore.datasource.type,
    datasourceId: explore.datasource_id,
    controls: explore.controls,
    can_overwrite: !!explore.can_overwrite,
    can_download: !!explore.can_download,
    column_formats: explore.datasource ? explore.datasource.column_formats : null,
    containerId: explore.slice ? `slice-container-${explore.slice.slice_id}` : 'slice-container',
    isStarred: explore.isStarred,
    slice: explore.slice,
    triggerRender: explore.triggerRender,
    form_data,
    table_name: form_data.datasource_name,
    vizType: form_data.viz_type,
    standalone: explore.standalone,
    forcedHeight: explore.forced_height,
    chart,
    timeout: explore.common.conf.SUPERSET_WEBSERVER_TIMEOUT,
    impressionId,
  };
}

function mapDispatchToProps(dispatch) {
  const actions = Object.assign({}, exploreActions, saveModalActions, chartActions);
  return {
    actions: bindActionCreators(actions, dispatch),
  };
}

export { ExploreViewContainer };
export default connect(mapStateToProps, mapDispatchToProps)(ExploreViewContainer);
