'use strict'

import R from 'ramda'
import flyd from 'flyd'
import m from 'mithril'
import jenkins from '../services/jenkins'
import { collectionMixin } from '../components/util'
import { Maybe } from 'ramda-fantasy'

const makeQuery = (q, ...args) => R.apply(R.merge, [{ query: { tree: R.ifElse(R.is(Array), R.join(','), R.identity)(q) } }].concat(args))
const nonEmpty = R.complement(R.either(R.isEmpty, R.isNil))

export const createModel = () => collectionMixin({
    bookmarks    : flyd.stream([]),
    jobs         : flyd.stream(),
    jenkins      : flyd.stream(),
    view         : flyd.stream(),
    views        : flyd.stream(),
    job          : flyd.stream(),
    queue        : flyd.stream([]),

    // -------------- View
    setView(view, opts = {}) {
        let viewQuery = ['jobs[lastSuccessfulBuild[timestamp],name,url,color,inQueue,actions[parameterDefinitions[*,defaultParameterValue[*]]]',
            'lastBuild[building,timestamp,estimatedDuration,number]]']

        return this.jenkins().req('view/' + view.name, makeQuery(viewQuery, opts))
            .then(R.compose(this.jobs, R.prop('jobs')))
            .then(R.tap(() => this.view(view)))
    },

    updateQueue() {
        return this.jenkins().req('queue', { background: true })
            .then(R.compose(this.queue, R.prop('items')))
    },

    updateView() {
        return this.setView(this.view(), { background: true }).then(m.redraw)
    },

    updateJob() {
        return this.setJob(this.job(), { background: true }).then(m.redraw)
    },

    // -------------- Queue
    cancelQueue(id) {
        // skip all errors, because the request returns a 302 HTTP code (redirect to previous page)
        // https://issues.jenkins-ci.org/browse/JENKINS-21311
        return this.jenkins().req('queue/cancelItem', {
            method: 'POST',
            issuer: true,
            query: { id },
            notify: false,
            deserialize: R.identity,
        }, '').catch(R.identity)
    },

    // -------------- Build
    getBuild(job, buildNumber, opts) {
        let q = ['actions[buildsByBranchName[buildNumber,revision[SHA1]]]',
            'result,timestamp,number,duration,estimatedDuration',
            'changeSet[*[affectedPaths,commitId,author[fullName],msg]]']

        return this.jenkins().req(`job/${job.name}/${buildNumber}`, makeQuery(q, opts))
    },
    runBuild(job, paramses) {
        return this.jenkins().req(`job/${job.name}/` + (nonEmpty(paramses) ? 'buildWithParameters' : 'build'), { method: 'POST', query: paramses, issuer: true })
    },
    stopBuild(job, buildNumber) {
        return this.jenkins().req(`job/${job.name}/${buildNumber}/stop`, { method: 'POST', issuer: true, deserialize: R.identity }, '')
    },

    // -------------- Job

    setJob(job, opts = {}) {
        let q = 'builds[number,result,timestamp,building,duration,estimatedDuration],name,inQueue,lastBuild[number,building],actions[parameterDefinitions[*,defaultParameterValue[*]]]'

        return this.jenkins().req(`job/${job.name}`, makeQuery(q, opts))
            .then((job) => Maybe(job.lastBuild)
                .map(build => this.getBuild(job, build.number, opts).then(R.assoc('selected', R.__, job)))
                .getOrElse(job))
            .then(this.job)
    },

    // -------------- Log

    getLogText(job, buildNumber, start, options) {
        return this.jenkins()
            .req(`job/${job.name}/${buildNumber}/logText/progressiveText`, R.merge({
                extract: (xhr) => {
                    let size = Number(xhr.getResponseHeader('x-text-size'))
                    let more = R.equals(xhr.getResponseHeader('x-more-data'), 'true')
                    return { logText: xhr.responseText, more, size }
                },
                query: { start }
            }, options))
    },

    pullLog(job, buildNumber) {
        const stream = flyd.stream()
        let stopped = false
        const stop = () => stopped = true
        const puller = (consumer, start, opts) =>
            this.getLogText(job, buildNumber, start, opts)
                .then((out) => {
                    consumer(out.logText)
                    if (R.and(R.equals(out.more, true), !stopped)) {
                        setTimeout(() => puller(consumer, out.size, { background: true }), 1000)
                    }
                    else {
                        consumer.end(true)
                    }
                    return consumer
                })
                .then(R.tap(m.redraw))

        return puller(stream)
            .then((stream) => !R.equals(stream.end(), true) ? flyd.scan(R.concat, '', stream) : stream)
            // stop console pulling on the stream end
            .then(R.tap(R.compose(flyd.on(stop), R.prop('end'))))
    },

    // -------------- Initialization

    init(credentials) {
        console.log('[jenkins] Initialize jenkins with credentials', credentials)
        const processResponse = R.tap(R.compose(this.views, R.prop('views')))
        return jenkins(credentials)
            .then(this.jenkins)
            .then(R.compose(processResponse, R.prop('info'), R.call))
    }
})
