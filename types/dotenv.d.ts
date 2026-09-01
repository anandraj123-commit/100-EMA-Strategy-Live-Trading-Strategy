declare module 'dotenv' {
  export interface DotenvConfigOptions {
    path?: string | string[];
    encoding?: BufferEncoding;
    debug?: boolean;
    override?: boolean;
    processEnv?: Record<string,string|undefined>;
  }

  export interface DotenvConfigOutput {
    error?: Error;
    parsed?: Record<string,string>;
  }

  const dotenv:{
    config(options?:DotenvConfigOptions):DotenvConfigOutput;
  };

  export default dotenv;
}
