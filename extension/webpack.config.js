const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    content: './content/content.js',
    background: './background/serviceWorker.js',
    popup: './popup/popup.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: (pathData) => {
      return pathData.chunk.name === 'popup' ? 'popup/popup.js' : '[name].js'
    }
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'styles', to: 'styles' },
        { from: 'fonts', to: 'fonts' },
        { from: 'icons', to: 'icons' },
        { from: 'popup/popup.html', to: 'popup/popup.html' },
        {
          from: 'node_modules/dictionary-en/index.aff',
          to: 'dict/index.aff'
        },
        {
          from: 'node_modules/dictionary-en/index.dic',
          to: 'dict/index.dic'
        }
      ]
    })
  ],
  resolve: {
    extensions: ['.js']
  },
  optimization: {
    splitChunks: false,
    runtimeChunk: false,
  },
  mode: 'production'
};
