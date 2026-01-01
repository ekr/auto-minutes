export default async function (eleventyConfig) {
  // Copy static assets
  eleventyConfig.addPassthroughCopy("site/**/*.txt");
  eleventyConfig.addPassthroughCopy("site/img");
  eleventyConfig.addPassthroughCopy("site/style.css");

  return {
    dir: {
      input: "site",
      output: "_site",
      layouts: "_layouts",
    },
    templateFormats: ["md"],
    // Disable liquid/template processing of markdown files
    // This prevents liquid from trying to parse {{ or {% in markdown content
    markdownTemplateEngine: false,
  };
}
