// Stage B: build DMN 1.3 XML from one intermediate model. Spec §6.
import { DmnModdle } from 'dmn-moddle';
import { camundaModdleDescriptor } from './camunda-moddle.js';
import { isAnyType } from './config.js';

const MODEL_NS = 'https://www.omg.org/spec/DMN/20191111/MODEL/';

function createModdle() {
  return new DmnModdle({ camunda: camundaModdleDescriptor });
}

/**
 * The `typeRef` attribute(s) to emit for a column, keyed off its typeRef.
 * Untyped ("any") columns emit the configured `types.anyDmnPlaceholder` when set,
 * otherwise no typeRef at all (Camunda renders that as "Any"). Typed columns pass through.
 */
function typeRefAttr(typeRef, cfg) {
  if (isAnyType(typeRef, cfg)) {
    const placeholder = cfg.types.anyDmnPlaceholder;
    return placeholder ? { typeRef: placeholder } : {};
  }
  return { typeRef };
}

/** Rewrite the dmn: prefix to the default (unprefixed) MODEL namespace. */
function toDefaultNamespace(xml) {
  return xml
    .replace(/<dmn:/g, '<')
    .replace(/<\/dmn:/g, '</')
    .replace(`xmlns:dmn="${MODEL_NS}"`, `xmlns="${MODEL_NS}"`);
}

/** Build a complete, standalone DMN 1.3 document string from one model. */
export async function buildDmn(model, cfg) {
  const moddle = createModdle();
  const d = model.decisions[0];
  const decId = d.id;

  const input = d.inputs.map((i) =>
    moddle.create('dmn:InputClause', {
      id: i.expression,
      ...(i.label ? { label: i.label } : {}),
      inputExpression: moddle.create('dmn:LiteralExpression', {
        id: `${i.expression}_expression`,
        ...typeRefAttr(i.typeRef, cfg),
        text: i.expression,
      }),
      ...(i.allowedValues
        ? { inputValues: moddle.create('dmn:UnaryTests', { text: i.allowedValues }) }
        : {}),
    }),
  );

  const output = d.outputs.map((o) =>
    moddle.create('dmn:OutputClause', {
      id: o.name,
      name: o.name,
      ...(o.label ? { label: o.label } : {}),
      ...typeRefAttr(o.typeRef, cfg),
      ...(o.allowedValues
        ? { outputValues: moddle.create('dmn:UnaryTests', { text: o.allowedValues }) }
        : {}),
    }),
  );

  const rule = d.rules.map((r) =>
    moddle.create('dmn:DecisionRule', {
      id: r.id,
      ...(r.description ? { description: r.description } : {}),
      inputEntry: r.inputEntries.map((text, i) =>
        moddle.create('dmn:UnaryTests', { id: `${d.inputs[i].expression}_${r.seq ?? r.row}`, text }),
      ),
      outputEntry: r.outputEntries.map((text, i) =>
        moddle.create('dmn:LiteralExpression', { id: `${d.outputs[i].name}_${r.seq ?? r.row}`, text }),
      ),
    }),
  );

  const table = moddle.create('dmn:DecisionTable', {
    id: `${decId}_decisionTable`,
    preferredOrientation: 'Rule-as-Row',
    ...(d.hitPolicy && d.hitPolicy !== 'UNIQUE' ? { hitPolicy: d.hitPolicy } : {}),
    ...(d.aggregation ? { aggregation: d.aggregation } : {}),
    input,
    output,
    rule,
  });

  const decision = moddle.create('dmn:Decision', {
    id: decId,
    name: d.name,
    ...(cfg.camunda.historyTimeToLive
      ? { historyTimeToLive: String(cfg.camunda.historyTimeToLive) }
      : {}),
    ...(cfg.camunda.versionTag ? { versionTag: String(cfg.camunda.versionTag) } : {}),
    decisionLogic: table,
  });

  const { x, y, width, height } = cfg.output.shape;
  const shape = moddle.create('dmndi:DMNShape', {
    id: `DMNShape_${decId}`,
    dmnElementRef: decision,
    isCollapsed: false,
    bounds: moddle.create('dc:Bounds', { x, y, width, height }),
  });
  const dmnDI = moddle.create('dmndi:DMNDI', {
    diagrams: [
      moddle.create('dmndi:DMNDiagram', { id: `DMNDiagram_${decId}`, diagramElements: [shape] }),
    ],
  });

  const definitions = moddle.create('dmn:Definitions', {
    id: model.definitions.id,
    name: model.definitions.name,
    namespace: model.definitions.namespace || cfg.output.namespace,
    expressionLanguage: cfg.output.expressionLanguage,
    typeLanguage: cfg.output.typeLanguage,
    drgElement: [decision],
    dmnDI,
  });

  let { xml } = await moddle.toXML(definitions, { format: cfg.output.format });
  if (cfg.output.namespaceStyle === 'default') xml = toDefaultNamespace(xml);
  return xml;
}

/** Re-parse produced XML to assert dmn-moddle accepts it (used in tests). */
export async function reparse(xml) {
  const moddle = createModdle();
  return moddle.fromXML(xml);
}
