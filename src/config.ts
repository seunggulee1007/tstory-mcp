import path from "node:path";

export interface Config {
  stateFile: string;
  /** 지정하지 않으면 myBlogs 의 defaultBlog 를 사용 */
  blog: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    stateFile: path.resolve(env.TISTORY_STATE_FILE || ".secrets/state.json"),
    blog: env.TISTORY_BLOG || undefined,
  };
}
