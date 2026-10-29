/* A recipe fixture that tries to declare project.json as authored bytes (tests only). */
export default async function () {
  return {
    project: {
      schemaVersion: 1,
      id: 'bad-project-json',
      revision: 1,
      title: 'Bad',
      direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
      assets: [],
      bindings: {},
      sources: [],
      composition: {
        output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [],
        shots: [],
        placements: [],
        transitions: [],
        audio: [],
      },
    },
    files: [{ path: 'project.json', bytes: '{}' }],
  };
}
