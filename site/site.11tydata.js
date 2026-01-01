export default {
  eleventyComputed: {
    permalink: (data) => {
      return `${data.page.filePathStem}.html`;
    }
  }
};
