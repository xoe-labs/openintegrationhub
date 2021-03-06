const { Event } = require('@openintegrationhub/event-bus');
const { v1 } = require('uuid');
const jwt = require('jsonwebtoken');

// TODO: Put secret into env
const ORCHESTRATOR_TOKEN_SECRET = 'foo';

const isProcessingFlow = {}

async function loop(body, logger, loopInterval) {
    logger.info('loop TICK');
    try {
        await body();
    } catch (e) {
        logger.error(e, 'loop body error');
    }
    setTimeout(async () => {
        loop(body, logger, loopInterval);
    }, loopInterval);
}


class ComponentOrchestrator {
    constructor({
        config,
        channel,
        logger,
        queuesManager,
        queueCreator,
        flowsDao,
        componentsDao,
        tokensDao,
        driver,
        eventBus,
    }) {
        this._config = config;
        this._logger = logger.child({ service: 'ComponentOrchestrator' });
        this._queuesManager = queuesManager;
        this._queueCreator = queueCreator;
        this._flowsDao = flowsDao;
        this._componentsDao = componentsDao;
        this._driver = driver;
        this._eventBus = eventBus;
        this._tokensDao = tokensDao;
        this._channel = channel;
    }

    async start() {
        // create backchannel exchange, queues and bindings
        await this._queuesManager.setupBackchannel();
        await this._queuesManager.subscribeBackchannel(
            this._handleMessage.bind(this)
        );

        loop(
            this._processState.bind(this),
            this._logger,
            this._config.get('TICK_INTERVAL') || 10000
        );
    }

    async _processState() {

        const allFlows = await this._flowsDao.findAll();
        const allApps = await this._driver.getAppList();

        const appsIndex = await this._buildDeploymentIndex(allApps);

        for (let flow of allFlows) {
            if (!isProcessingFlow[flow.id]) {
                isProcessingFlow[flow.id] = true
                this._handleFlowState(flow, appsIndex)
                    .catch((err) => this._logger.error({ err, flow }, 'Failed to process flow'))
                    .finally(() => delete isProcessingFlow[flow.id])
            }
        }

        this._removeLostDeployments(allApps, allFlows)
            .catch(err => this._logger.error({ err }));
    }

    async _handleFlowState(flow, appsIndex) {

        const logger = this._logger.child({ flowId: flow.id });
        logger.trace(
            { nodes: Object.keys(appsIndex[flow.id] || {}) },
            'Flow nodes already running'
        );

        if (flow.isStopping) {
            await this._deleteRunningDeploymentsForFlow(flow, appsIndex);
            await this._queuesManager.deleteForFlow(flow);
            await this._tokensDao.deleteTokenForFlowAndUser({
                flowId: flow.id,
                userId: flow.startedBy,
            });
            await this._sendFlowStoppedEvent(flow);
            await flow.onStopped();
            return;
        }

        const nodes = await flow.getNodes();
        const components = {}

        for (let node of nodes) {
            if (!appsIndex[flow.id] || !appsIndex[flow.id][node.id]) {

                const component = await this._componentsDao.findById(node.componentId)
                components[node.componentId] = component

                if (component.isGlobal) {
                    logger.trace(
                        { componentId: node.componentId },
                        'Skip global component'
                    );
                    continue;
                }

                if (!component) {
                    logger.warn(
                        { componentId: node.componentId },
                        'Component not found'
                    );
                    continue;
                }

                logger.trace({ component }, 'Found component');

                logger.trace({ nodeId: node.id }, 'Going to deploy a flow node');

                const flowSettings = await this._queuesManager.prepareQueues(
                    flow,
                    components
                );

                //@todo: abstraction for settings
                const envVars = await this._queuesManager.getSettingsForNodeExecution(
                    flow,
                    node,
                    flowSettings
                );

                await this._driver.createApp({
                    flow,
                    node,
                    envVars,
                    component,
                    options: {
                        replicas: 1,
                        imagePullPolicy: this._config.get('KUBERNETES_IMAGE_PULL_POLICY'),
                    },
                });
            }
        }

        if (flow.isStarting) {
            if (flow.startedBy) {
                try {
                    await this._tokensDao.getTokenForFlowAndUser({
                        flowId: flow.id,
                        userId: flow.startedBy,
                    });
                } catch (e) {
                    logger.error(e, 'Failed to get IAM token');
                }
            }
            await this._sendFlowStartedEvent(flow);
            await flow.onStarted();
        }
    }

    async _sendFlowStartedEvent(flow) {
        const event = new Event({
            headers: {
                name: 'flow.started',
            },
            payload: { id: flow.id },
        });

        await this._eventBus.publish(event);
    }

    async _sendFlowStoppedEvent(flow) {
        const event = new Event({
            headers: {
                name: 'flow.stopped',
            },
            payload: { id: flow.id },
        });

        await this._eventBus.publish(event);
    }

    _buildDeploymentIndex(allDeployments) {
        const result = allDeployments.reduce((index, app) => {
            if (app.flowId) {
                // deployment is part of flow
                const flowId = app.flowId;
                const nodeId = app.nodeId;
                index[flowId] = index[flowId] || {};
                index[flowId][nodeId] = app;
            } else {
                // deployment is global component
                const componentId = app.componentId;
                index[componentId] = app;
            }
            return index;
        }, {});
        return result;
    }

    async _deleteRunningDeploymentsForFlow(flow, appsIndex) {
        for (let app of Object.values(appsIndex[flow.id] || {})) {
            if (app.type !== 'global') {
                this._logger.trace(
                    { flow: flow.id, app: app.id },
                    'Going to delete flow node'
                );
                await this._driver.destroyApp(app);
            } else {
                this._logger.trace(
                    { flow: flow.id, app: app.id },
                    'Skipped delete flow node (global component)'
                );
            }
        }
    }

    async _removeLostDeployments(allApps, allFlows) {
        const flowsIndex = this._buildFlowsIndex(allFlows);
        for (let app of allApps) {
            const flowId = app.flowId;
            const nodeId = app.nodeId;
            if (
                app.type !== 'global' &&
                (!flowsIndex[flowId] || !flowsIndex[flowId][nodeId])
            ) {
                await this._driver.destroyApp(app);
            }
        }
    }

    _buildFlowsIndex(allFlows) {
        return allFlows.reduce((index, flow) => {
            const flowId = flow.id;
            (flow.graph.nodes || []).forEach((node) => {
                index[flowId] = index[flowId] || {};
                index[flowId][node.id] = node;
            });
            return index;
        }, {});
    }

    async _handleMessage(message) {
        try {
            const { orchestratorToken } = message.properties.headers;
            const { stepId, flowId, apiKey } = jwt.verify(orchestratorToken, ORCHESTRATOR_TOKEN_SECRET);

            const flow = await this._flowsDao.findById(flowId);

            const nextSteps = flow.getNextSteps(stepId);

            this._logger.info(`Done ${flowId}:${stepId}`);

            if (nextSteps.length) {
                const promises = nextSteps.map((stepId) => {
                    const componentId = flow.getComponentPropertiesByStep(stepId).componentId

                    return this._componentsDao.findById(componentId).then((component) =>
                        this._executeStep({
                            flow,
                            stepId,
                            component,
                            apiKey,
                            msg: JSON.parse(message.content.toString())
                        })
                    );
                });
                Promise.all(promises);
            }
        } catch (err) {
            const { taskId, stepId } = message.properties.headers;
            this._logger.error({ err, taskId, stepId }, 'Failed to process result');
        }
    }

    async _executeStep({
        flow,
        stepId,
        component,
        apiKey,
        msg,
    }) {

        const functionName = flow.getComponentPropertiesByStep(stepId).function
        const secretId = flow.getComponentPropertiesByStep(stepId).credentials_id
        const fields = flow.getComponentPropertiesByStep(stepId).fields

        const orchestratorToken = jwt.sign(
            {
                flowId: flow._id.toString(),
                stepId,
                userId: flow.startedBy,
                function: functionName,
                secretId,
                fields,
                apiKey,
            },
            ORCHESTRATOR_TOKEN_SECRET
        );

        const record = {
            taskId: flow._id.toString(),
            execId: v1().replace(/-/g, ''),
            userId: 'DOES NOT MATTER', // Required by Sailor
            stepId,
            orchestratorToken,
        };

        //@todo: introduce common Message class
        const newMessage = {
            id: v1(),
            attachments: msg.attachments || {},
            body: msg.body || {},
            headers: msg.header || {},
            metadata: msg.metadata || {},
        };

        let config;

        if (component.isGlobal) {
            config = this._queueCreator.getAmqpGlobalStepConfig(component);
        } else {
            config = this._queueCreator.getAmqpStepConfig(flow, stepId);
        }

        const { messagesQueue, exchangeName, deadLetterRoutingKey } = config;

        await this._queueCreator.assertMessagesQueue(
            messagesQueue,
            exchangeName,
            deadLetterRoutingKey
        );

        await this._channel.sendToQueue(
            messagesQueue,
            Buffer.from(JSON.stringify(newMessage)),
            {
                contentType: 'text/json',
                headers: record,
            }
        );
    }

    async executeFlow({ flow, msg = {} /*,  msgOpts = {} */ } /* , { type } */) {
        const _flow = await this._flowsDao.findById(flow._id);

        const { token } = await this._tokensDao.getTokenByFlowId({
            flowId: _flow._id,
        });
        const firstNode = _flow.getFirstNode();
        const stepId = firstNode.id;
        const component = await this._componentsDao.findById(firstNode.componentId);

        await this._executeStep({
            flow: _flow,
            stepId,
            component,
            apiKey: token,
            msg,
        });
    }

    async startComponent(component) {
        component.id = component.id || component._id;
        const envVars = await this._queuesManager.getSettingsForGlobalComponent(
            component,
            await this._queuesManager.prepareQueuesForGlobalComponent(component)
        );

        await this._driver.createApp({
            envVars,
            component,
            options: {
                replicas: 1,
                imagePullPolicy: this._config.get('KUBERNETES_IMAGE_PULL_POLICY'),
            },
        });

        this._sendComponentStartedEvent(component);
    }

    async stopComponent(component) {
        component.id = component.id || component._id;
        await this._queuesManager.deleteForGlobalComponent(component);

        await this._driver.destroyApp({
            name: `global-${component.id}`,
            type: 'global',
            componentId: component.id,
        });
        this._sendComponentStoppedEvent(component);
    }

    async _sendComponentStartedEvent(component) {
        const event = new Event({
            headers: {
                name: 'component.started',
            },
            payload: { id: component.id },
        });

        await this._eventBus.publish(event);
    }

    async _sendComponentStoppedEvent(component) {
        const event = new Event({
            headers: {
                name: 'component.stopped',
            },
            payload: { id: component.id },
        });

        await this._eventBus.publish(event);
    }
}

module.exports = ComponentOrchestrator;
