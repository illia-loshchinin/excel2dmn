// Minimal Camunda 7 DMN moddle extension: adds historyTimeToLive / versionTag
// as attributes on <decision>. Shipped inline — no extra dependency (spec §6.5).

export const camundaModdleDescriptor = {
  name: 'Camunda',
  uri: 'http://camunda.org/schema/1.0/dmn',
  prefix: 'camunda',
  xml: { tagAlias: 'lowerCase' },
  types: [
    {
      name: 'CamundaDecision',
      extends: ['dmn:Decision'],
      properties: [
        { name: 'historyTimeToLive', isAttr: true, type: 'String' },
        { name: 'versionTag', isAttr: true, type: 'String' },
      ],
    },
  ],
};

// Camunda 8 modeler metadata: adds executionPlatform / executionPlatformVersion
// as attributes on <definitions>. Shipped inline — no extra dependency.
export const modelerModdleDescriptor = {
  name: 'ModelerDmn',
  uri: 'http://camunda.org/schema/modeler/1.0',
  prefix: 'modeler',
  xml: { tagAlias: 'lowerCase' },
  types: [
    {
      name: 'ModelerDefinitions',
      extends: ['dmn:Definitions'],
      properties: [
        { name: 'executionPlatform', isAttr: true, type: 'String' },
        { name: 'executionPlatformVersion', isAttr: true, type: 'String' },
      ],
    },
  ],
};
