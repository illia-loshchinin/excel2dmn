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
