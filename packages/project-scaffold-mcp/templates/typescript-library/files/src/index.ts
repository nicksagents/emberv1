export interface GreetingOptions {
  audience: string;
}

export function greet(options: GreetingOptions): string {
  return `Hello, ${options.audience}. {{app_title}} is ready for real code.`;
}
