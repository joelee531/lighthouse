/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const ByteEfficiencyAudit = require('./byte-efficiency-audit.js');
const BundleAnalysis = require('../../computed/bundle-analysis.js');
const i18n = require('../../lib/i18n/i18n.js');

const UIStrings = {
  /** Imperative title of a Lighthouse audit that tells the user to remove JavaScript that is never evaluated during page load. This is displayed in a list of audit titles that Lighthouse generates. */
  title: 'Remove unused JavaScript',
  /** Description of a Lighthouse audit that tells the user *why* they should remove JavaScript that is never needed/evaluated by the browser. This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. */
  description: 'Remove unused JavaScript to reduce bytes consumed by network activity. ' +
    '[Learn more](https://developers.google.com/web/fundamentals/performance/optimizing-javascript/code-splitting).',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

const IGNORE_THRESHOLD_IN_BYTES = 2048;

/**
 * @typedef WasteData
 * @property {Uint8Array} unusedByIndex
 * @property {number} unusedLength
 * @property {number} contentLength
 */

class UnusedJavaScript extends ByteEfficiencyAudit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'unused-javascript',
      title: str_(UIStrings.title),
      description: str_(UIStrings.description),
      scoreDisplayMode: ByteEfficiencyAudit.SCORING_MODES.NUMERIC,
      requiredArtifacts: ['JsUsage', 'SourceMaps', 'ScriptElements', 'devtoolsLogs', 'traces'],
    };
  }

  /**
   * @param {LH.Crdp.Profiler.ScriptCoverage} scriptCoverage
   * @return {WasteData}
   */
  static computeWaste(scriptCoverage) {
    let maximumEndOffset = 0;
    for (const func of scriptCoverage.functions) {
      maximumEndOffset = Math.max(maximumEndOffset, ...func.ranges.map(r => r.endOffset));
    }

    // We only care about unused ranges of the script, so we can ignore all the nesting and safely
    // assume that if a range is unexecuted, all nested ranges within it will also be unexecuted.
    const unusedByIndex = new Uint8Array(maximumEndOffset);
    for (const func of scriptCoverage.functions) {
      for (const range of func.ranges) {
        if (range.count === 0) {
          for (let i = range.startOffset; i < range.endOffset; i++) {
            unusedByIndex[i] = 1;
          }
        }
      }
    }

    let unused = 0;
    for (const x of unusedByIndex) {
      unused += x;
    }

    return {
      unusedByIndex,
      unusedLength: unused,
      contentLength: maximumEndOffset,
    };
  }

  /**
   * @param {LH.Audit.ByteEfficiencyItem} item
   * @param {WasteData[]} wasteData
   * @param {import('../../computed/bundle-analysis.js').Bundle} bundle
   */
  static createBundleMultiData(item, wasteData, bundle) {
    if (!bundle.script.content) return;

    /** @type {Record<string, number>} */
    const files = {};
    let line = 0;
    let column = 0;
    for (let i = 0; i < bundle.script.content.length; i++) {
      column += 1;
      // TODO..... this can't be good.
      if (bundle.script.content[i] === '\n') {
        line += 1;
        column = 0;
      }
      if (wasteData.every(data => data.unusedByIndex[i] === 1)) continue;

      // @ts-ignore: ughhhhh the tsc doesn't work for the compiled cdt lib
      const mapping = bundle.map.findEntry(line, column);
      files[mapping.sourceURL] = (files[mapping.sourceURL] || 0) + 1;
    }

    const unusedFilesSizesSorted = Object.entries(files)
      .sort((a, b) => b[1] - a[1])
      .filter(d => d[1] >= 1024)
      .slice(0, 5)
      .map(d => {
        return {
          key: d[0],
          unused: d[1],
          total: bundle.sizes.files[d[0]],
        };
      });

    item.multi = {
      type: 'multi',
      url: unusedFilesSizesSorted.map(d => d.key),
      totalBytes: unusedFilesSizesSorted.map(d => d.total),
      wastedBytes: unusedFilesSizesSorted.map(d => d.unused),
    };
  }

  /**
   * @param {WasteData[]} wasteData
   * @param {LH.Artifacts.NetworkRequest} networkRecord
   * @return {LH.Audit.ByteEfficiencyItem}
   */
  static mergeWaste(wasteData, networkRecord) {
    let unusedLength = 0;
    let contentLength = 0;
    for (const usage of wasteData) {
      unusedLength += usage.unusedLength;
      contentLength += usage.contentLength;
    }

    const totalBytes = ByteEfficiencyAudit.estimateTransferSize(networkRecord, contentLength,
        'Script');
    const wastedRatio = (unusedLength / contentLength) || 0;
    const wastedBytes = Math.round(totalBytes * wastedRatio);

    return {
      url: networkRecord.url,
      totalBytes,
      wastedBytes,
      wastedPercent: 100 * wastedRatio,
    };
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {Array<LH.Artifacts.NetworkRequest>} networkRecords
   * @param {LH.Audit.Context} context
   * @return {Promise<ByteEfficiencyAudit.ByteEfficiencyProduct>}
   */
  static async audit_(artifacts, networkRecords, context) {
    const bundles = await BundleAnalysis.request(artifacts, context);

    /** @type {Map<string, Array<LH.Crdp.Profiler.ScriptCoverage>>} */
    const scriptsByUrl = new Map();
    for (const script of artifacts.JsUsage) {
      const scripts = scriptsByUrl.get(script.url) || [];
      scripts.push(script);
      scriptsByUrl.set(script.url, scripts);
    }

    const items = [];
    for (const [url, scriptCoverage] of scriptsByUrl.entries()) {
      const networkRecord = networkRecords.find(record => record.url === url);
      if (!networkRecord) continue;
      const wasteData = scriptCoverage.map(UnusedJavaScript.computeWaste);
      const bundle = bundles.find(b => b.networkRecord === networkRecord);
      const item = UnusedJavaScript.mergeWaste(wasteData, networkRecord);
      if (item.wastedBytes <= IGNORE_THRESHOLD_IN_BYTES) continue;
      if (bundle) {
        UnusedJavaScript.createBundleMultiData(item, wasteData, bundle);
      }
      items.push(item);
    }

    return {
      items,
      headings: [
        {key: 'url', valueType: 'url', multi: true, label: str_(i18n.UIStrings.columnURL)},
        {key: 'totalBytes', valueType: 'bytes', multi: true, label: str_(i18n.UIStrings.columnSize)},
        {key: 'wastedBytes', valueType: 'bytes', multi: true, label: str_(i18n.UIStrings.columnWastedBytes)},
      ],
    };
  }
}

module.exports = UnusedJavaScript;
module.exports.UIStrings = UIStrings;
