/// @ts-check
import fs from "fs/promises";
import path from "path";
import { resolveOriginalLocations } from "./resolveOriginalLocations.mjs";

/** @typedef {{ columnNumber:number, lineNumber: number, url: string, functionName: string }} Tracable */

/** @typedef {import('./traceTypes').Trace | import('./traceTypes').Trace['traceEvents']} Profile */

/**
 * Resolves all Google Trace Format json file and resolves all sourcemaps
 * https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/edit#
 *
 * Warning this function will modify the given profile!
 *
 * @template {Profile} TProfile
 * @param {TProfile} profile
 * @param {string} [nodeModulesPath]
 * @returns {Promise<TProfile>}
 */
export async function applySourceMapsForProfile(profile, nodeModulesPath) {
  /** @type {Tracable[]} */
  const traces = [];

  /** @type {import('./traceTypes').Trace['traceEvents']} */
  const traceEvents =
    "traceEvents" in profile
      ? profile.traceEvents
      : Array.isArray(profile)
      ? profile
      : [];

  // Search the profile for StackTrace entries
  traceEvents.forEach((event) => {
    const dataArgs = /** @type {const} */ (["data", "beginData"]);
    dataArgs.forEach((dataName) => {
      const data = dataName in event.args && event.args[dataName];
      if (!data) {
        return;
      }

      if (data.stackTrace) {
        const { stackTrace } = data;
        stackTrace.forEach((trace) => {
          if (isTrace(trace)) {
            traces.push(trace);
          }
        });
      }

      if ("cpuProfile" in data && data.cpuProfile && data.cpuProfile.nodes) {
        const { nodes } = data.cpuProfile;
        nodes.forEach((node) => {
          const trace = node.callFrame;
          if (isTrace(trace)) {
            traces.push(trace);
          }
        });
      }

      if (isTrace(data)) {
        traces.push(data);
      }
    });
  });

  await resolveTracesForUrlAssets(traces);

  if (nodeModulesPath) {
    await resolveTracesForNodeModules(traces, nodeModulesPath);
  }

  return profile;
}

/**
 * \!/ Warning this function modifies the trace param
 *
 * @param {Tracable[]} traces
 */
async function resolveTracesForUrlAssets(traces) {
  let resolvePromises = [];
  /** @type {Map<string, Tracable[]>} */
  const urlTraceMapping = new Map();
  traces.forEach((trace) => {
    if (!trace.url.startsWith("http")) {
      return;
    }
    const urlTracesFromMapping = urlTraceMapping.get(trace.url);
    const urlTraces = urlTracesFromMapping || [];
    if (!urlTracesFromMapping) {
      urlTraceMapping.set(trace.url, urlTraces);
    }
    urlTraces.push(trace);
  });

  for (const [url, traces] of urlTraceMapping.entries()) {
    resolvePromises.push(
      resolveOriginalLocations(
        url,
        traces.map((traceable) => ({
          column: traceable.columnNumber,
          line: traceable.lineNumber
        }))
      ).then((resolvedLocations) => {
        resolvedLocations.forEach((resolvedLocation, i) => {
          const trace = traces[i];
          trace.columnNumber = resolvedLocation.column;
          trace.lineNumber = resolvedLocation.line;
          trace.url = resolvedLocation.source || trace.url;
          trace.functionName = resolvedLocation.name || trace.functionName;
        });
      })
    );
  }

  // Wait until all modifications are done
  await Promise.all(resolvePromises);

  return traces;
}

/**
 * \!/ Warning this function modifies the trace param
 *
 * @param {Tracable[]} traces
 * @param {string} nodeModulesPath
 */
async function resolveTracesForNodeModules(traces, nodeModulesPath) {
  let resolvePromises = [];
  const nodeModuleLoader = async (url) => {
    const resolvedUrl = path.resolve(nodeModulesPath, url);
    try {
      return await fs.readFile(resolvedUrl, "utf-8");
    } catch (e) {
      console.warn("Could not read ", resolvedUrl);
    }
    return "";
  };
  /** @type {Map<string, Tracable[]>} */
  const urlTraceMapping = new Map();
  traces.forEach((trace) => {
    if (!trace.url.startsWith("node_modules")) {
      return;
    }
    const urlTracesFromMapping = urlTraceMapping.get(trace.url);
    const urlTraces = urlTracesFromMapping || [];
    if (!urlTracesFromMapping) {
      urlTraceMapping.set(trace.url, urlTraces);
    }
    urlTraces.push(trace);
  });

  for (const [url, traces] of urlTraceMapping.entries()) {
    resolvePromises.push(
      resolveOriginalLocations(
        url,
        traces.map((traceable) => ({
          column: traceable.columnNumber,
          line: traceable.lineNumber
        })),
        nodeModuleLoader
      ).then((resolvedLocations) => {
        resolvedLocations.forEach((resolvedLocation, i) => {
          const trace = traces[i];
          trace.columnNumber = resolvedLocation.column;
          trace.lineNumber = resolvedLocation.line;
          trace.url = resolvedLocation.source || trace.url;
          trace.functionName = resolvedLocation.name || trace.functionName;
          if (trace.url.includes("node_modules")) {
            trace.url = trace.url.replace(/.*?(node_modules)/, "$1");
          }
        });
      })
    );
  }

  // Wait until all modifications are done
  await Promise.all(resolvePromises);

  return traces;
}

/**
 * @param {{url?:string, functionName?:string, lineNumber?: number, columnNumber?: number}} trace
 * @returns {trace is {url:string, functionName: string, lineNumber: number, columnNumber: number}}
 */
function isTrace(trace) {
  return (
    "url" in trace &&
    typeof trace.url === "string" &&
    "functionName" in trace &&
    typeof trace.functionName === "string" &&
    "lineNumber" in trace &&
    typeof trace.lineNumber === "number" &&
    "columnNumber" in trace &&
    typeof trace.columnNumber === "number"
  );
}
