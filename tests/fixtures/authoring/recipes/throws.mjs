/* A recipe fixture that throws before returning a draft (tests only). */
export default async function () {
  throw new Error('fixture recipe failed deliberately');
}
