// Reverse Stage B: parse a DMN 1.3 file into intermediate model(s). Spec §16 (interop).
import { DmnModdle } from 'dmn-moddle';
import { camundaModdleDescriptor, modelerModdleDescriptor } from './camunda-moddle.js';
import { isAnyType } from './config.js';

function moddle() {
  return new DmnModdle({ camunda: camundaModdleDescriptor, modeler: modelerModdleDescriptor });
}

const text = (el) => (el && el.text != null ? String(el.text) : '');

/** Parse DMN XML into an array of intermediate models (one per decision table). */
export async function dmnToModels(xml, cfg) {
  const { rootElement: defs, warnings } = await moddle().fromXML(xml);
  if (warnings && warnings.length) {
    // non-fatal, but surface via thrown message on hard structural issues only
  }
  const decisions = (defs.drgElement || []).filter(
    (e) =>
      e.$type === 'dmn:Decision' &&
      e.decisionLogic &&
      e.decisionLogic.$type === 'dmn:DecisionTable',
  );
  if (!decisions.length)
    throw new Error('No <decision> with a <decisionTable> found in the DMN file');

  return decisions.map((dec) => {
    const table = dec.decisionLogic;
    const anyKw = cfg.types.anyKeyword;
    const inputs = (table.input || []).map((inp) => {
      const expr = inp.inputExpression || {};
      return {
        label: inp.label || undefined,
        expression: text(expr) || inp.id,
        typeRef: !expr.typeRef || isAnyType(expr.typeRef, cfg) ? anyKw : expr.typeRef,
        allowedValues: inp.inputValues ? text(inp.inputValues) || null : null,
      };
    });
    const outputs = (table.output || []).map((out) => ({
      name: out.name || out.id,
      label: out.label || undefined,
      typeRef: !out.typeRef || isAnyType(out.typeRef, cfg) ? anyKw : out.typeRef,
      allowedValues: out.outputValues ? text(out.outputValues) || null : null,
    }));
    const rules = (table.rule || []).map((rule, i) => {
      const row = (cfg.rules.startOffset || 5) + 1 + i;
      const r = {
        seq: i + 1,
        id: (cfg.rules.idTemplate || 'rule_<n>').replace('<n>', String(i + 1)).replace('<row>', String(row)),
        row,
        inputEntries: (rule.inputEntry || []).map(text),
        outputEntries: (rule.outputEntry || []).map(text),
      };
      if (rule.description) r.description = String(rule.description);
      return r;
    });

    const id = dec.id;
    const name = dec.name || id;
    return {
      definitions: {
        id: defs.id || `definitions_${id}`,
        name: defs.name || name,
        namespace: defs.namespace || cfg.output.namespace,
      },
      decisions: [
        {
          id,
          name,
          hitPolicy: (table.hitPolicy || 'UNIQUE').toUpperCase(),
          aggregation: table.aggregation || null,
          inputs,
          outputs,
          rules,
        },
      ],
      __camunda: {
        historyTimeToLive: dec.historyTimeToLive || null,
        versionTag: dec.versionTag || null,
      },
      // Detected target platform: Camunda 8 files carry modeler:executionPlatform="Camunda Cloud".
      __platform: defs.executionPlatform === 'Camunda Cloud' ? 'camunda8' : 'camunda7',
      __camunda8: {
        executionPlatform: defs.executionPlatform || null,
        executionPlatformVersion: defs.executionPlatformVersion || null,
      },
    };
  });
}
