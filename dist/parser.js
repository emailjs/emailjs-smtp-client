'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
/**
 * Generates a parser object for data coming from a SMTP server
 *
 * @constructor
 */
var SmtpResponseParser = function SmtpResponseParser() {
  /**
   * If the complete line is not received yet, contains the beginning of it
   */
  this._remainder = '';

  /**
   * If the response is a list, contains previous not yet emitted lines
   */
  this._block = {
    data: [],
    lines: [],
    statusCode: null

    /**
     * If set to true, do not accept any more input
     */
  };this.destroyed = false;
};

// Event handlers

/**
 * NB! Errors do not block, the parsing and data emitting continues despite of the errors
 */
SmtpResponseParser.prototype.onerror = function () {};
SmtpResponseParser.prototype.ondata = function () {};
SmtpResponseParser.prototype.onend = function () {};

// Public API

/**
 * Queue some data from the server for parsing. Only allowed, if 'end' has not been called yet
 *
 * @param {String} chunk Chunk of data received from the server
 */
SmtpResponseParser.prototype.send = function (chunk) {
  if (this.destroyed) {
    return this.onerror(new Error('This parser has already been closed, "write" is prohibited'));
  }

  // Lines should always end with <CR><LF> but you never know, might be only <LF> as well
  var lines = (this._remainder + (chunk || '')).split(/\r?\n/);
  this._remainder = lines.pop(); // not sure if the line has completely arrived yet

  for (var i = 0, len = lines.length; i < len; i++) {
    this._processLine(lines[i]);
  }
};

/**
 * Indicate that all the data from the server has been received. Can be called only once.
 *
 * @param {String} [chunk] Chunk of data received from the server
 */
SmtpResponseParser.prototype.end = function (chunk) {
  if (this.destroyed) {
    return this.onerror(new Error('This parser has already been closed, "end" is prohibited'));
  }

  if (chunk) {
    this.send(chunk);
  }

  if (this._remainder) {
    this._processLine(this._remainder);
  }

  this.destroyed = true;
  this.onend();
};

// Private API

/**
 * Processes a single and complete line. If it is a continous one (slash after status code),
 * queue it to this._block
 *
 * @param {String} line Complete line of data from the server
 */
SmtpResponseParser.prototype._processLine = function (line) {
  var match, response;

  // possible input strings for the regex:
  // 250-MESSAGE
  // 250 MESSAGE
  // 250 1.2.3 MESSAGE

  if (!line.trim()) {
    // nothing to check, empty line
    return;
  }

  this._block.lines.push(line);

  if (match = line.match(/^(\d{3})([- ])(?:(\d+\.\d+\.\d+)(?: ))?(.*)/)) {
    this._block.data.push(match[4]);

    if (match[2] === '-') {
      if (this._block.statusCode && this._block.statusCode !== Number(match[1])) {
        this.onerror('Invalid status code ' + match[1] + ' for multi line response (' + this._block.statusCode + ' expected)');
      } else if (!this._block.statusCode) {
        this._block.statusCode = Number(match[1]);
      }
    } else {
      response = {
        statusCode: Number(match[1]) || 0,
        enhancedStatus: match[3] || null,
        data: this._block.data.join('\n'),
        line: this._block.lines.join('\n')
      };
      response.success = response.statusCode >= 200 && response.statusCode < 300;

      this.ondata(response);
      this._block = {
        data: [],
        lines: [],
        statusCode: null
      };
      this._block.statusCode = null;
    }
  } else {
    this.onerror(new Error('Invalid SMTP response "' + line + '"'));
    this.ondata({
      success: false,
      statusCode: this._block.statusCode || null,
      enhancedStatus: null,
      data: [line].join('\n'),
      line: this._block.lines.join('\n')
    });
    this._block = {
      data: [],
      lines: [],
      statusCode: null
    };
  }
};

exports.default = SmtpResponseParser;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9wYXJzZXIuanMiXSwibmFtZXMiOlsiU210cFJlc3BvbnNlUGFyc2VyIiwiX3JlbWFpbmRlciIsIl9ibG9jayIsImRhdGEiLCJsaW5lcyIsInN0YXR1c0NvZGUiLCJkZXN0cm95ZWQiLCJwcm90b3R5cGUiLCJvbmVycm9yIiwib25kYXRhIiwib25lbmQiLCJzZW5kIiwiY2h1bmsiLCJFcnJvciIsInNwbGl0IiwicG9wIiwiaSIsImxlbiIsImxlbmd0aCIsIl9wcm9jZXNzTGluZSIsImVuZCIsImxpbmUiLCJtYXRjaCIsInJlc3BvbnNlIiwidHJpbSIsInB1c2giLCJOdW1iZXIiLCJlbmhhbmNlZFN0YXR1cyIsImpvaW4iLCJzdWNjZXNzIl0sIm1hcHBpbmdzIjoiOzs7OztBQUFBOzs7OztBQUtBLElBQU1BLHFCQUFxQixTQUFyQkEsa0JBQXFCLEdBQVk7QUFDckM7OztBQUdBLE9BQUtDLFVBQUwsR0FBa0IsRUFBbEI7O0FBRUE7OztBQUdBLE9BQUtDLE1BQUwsR0FBYztBQUNaQyxVQUFNLEVBRE07QUFFWkMsV0FBTyxFQUZLO0FBR1pDLGdCQUFZOztBQUdkOzs7QUFOYyxHQUFkLENBU0EsS0FBS0MsU0FBTCxHQUFpQixLQUFqQjtBQUNELENBbkJEOztBQXFCQTs7QUFFQTs7O0FBR0FOLG1CQUFtQk8sU0FBbkIsQ0FBNkJDLE9BQTdCLEdBQXVDLFlBQVksQ0FBRyxDQUF0RDtBQUNBUixtQkFBbUJPLFNBQW5CLENBQTZCRSxNQUE3QixHQUFzQyxZQUFZLENBQUcsQ0FBckQ7QUFDQVQsbUJBQW1CTyxTQUFuQixDQUE2QkcsS0FBN0IsR0FBcUMsWUFBWSxDQUFHLENBQXBEOztBQUVBOztBQUVBOzs7OztBQUtBVixtQkFBbUJPLFNBQW5CLENBQTZCSSxJQUE3QixHQUFvQyxVQUFVQyxLQUFWLEVBQWlCO0FBQ25ELE1BQUksS0FBS04sU0FBVCxFQUFvQjtBQUNsQixXQUFPLEtBQUtFLE9BQUwsQ0FBYSxJQUFJSyxLQUFKLENBQVUsNERBQVYsQ0FBYixD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LFVBQVosR0FBeUIsSUFBekI7QUFDRDtBQUNGLEdBM0JELE1BMkJPO0FBQ0wsU0FBS0csT0FBTCxDQUFhLElBQUlLLEtBQUosQ0FBVSw0QkFBNEJRLElBQTVCLEdBQW1DLEdBQTdDLENBQWI7QUFDQSxTQUFLWixNQUFMLENBQVk7QUFDVm9CLGVBQVMsS0FEQztBQUVWeEIsa0JBQVksS0FBS0gsTUFBTCxDQUFZRyxVQUFaLElBQTBCLElBRjVCO0FBR1ZzQixzQkFBZ0IsSUFITjtBQUlWeEIsWUFBTSxDQUFDa0IsSUFBRCxFQUFPTyxJQUFQLENBQVksSUFBWixDQUpJO0FBS1ZQLFlBQU0sS0FBS25CLE1BQUwsQ0FBWUUsS0FBWixDQUFrQndCLElBQWxCLENBQXVCLElBQXZCO0FBTEksS0FBWjtBQU9BLFNBQUsxQixNQUFMLEdBQWM7QUFDWkMsWUFBTSxFQURNO0FBRVpDLGFBQU8sRUFGSztBQUdaQyxrQkFBWTtBQUhBLEtBQWQ7QUFLRDtBQUNGLENBekREOztrQkEyRGVMLGtCIiwiZmlsZSI6InBhcnNlci5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogR2VuZXJhdGVzIGEgcGFyc2VyIG9iamVjdCBmb3IgZGF0YSBjb21pbmcgZnJvbSBhIFNNVFAgc2VydmVyXG4gKlxuICogQGNvbnN0cnVjdG9yXG4gKi9cbmNvbnN0IFNtdHBSZXNwb25zZVBhcnNlciA9IGZ1bmN0aW9uICgpIHtcbiAgLyoqXG4gICAqIElmIHRoZSBjb21wbGV0ZSBsaW5lIGlzIG5vdCByZWNlaXZlZCB5ZXQsIGNvbnRhaW5zIHRoZSBiZWdpbm5pbmcgb2YgaXRcbiAgICovXG4gIHRoaXMuX3JlbWFpbmRlciA9ICcnXG5cbiAgLyoqXG4gICAqIElmIHRoZSByZXNwb25zZSBpcyBhIGxpc3QsIGNvbnRhaW5zIHByZXZpb3VzIG5vdCB5ZXQgZW1pdHRlZCBsaW5lc1xuICAgKi9cbiAgdGhpcy5fYmxvY2sgPSB7XG4gICAgZGF0YTogW10sXG4gICAgbGluZXM6IFtdLFxuICAgIHN0YXR1c0NvZGU6IG51bGxcbiAgfVxuXG4gIC8qKlxuICAgKiBJZiBzZXQgdG8gdHJ1ZSwgZG8gbm90IGFjY2VwdCBhbnkgbW9yZSBpbnB1dFxuICAgKi9cbiAgdGhpcy5kZXN0cm95ZWQgPSBmYWxzZVxufVxuXG4vLyBFdmVudCBoYW5kbGVyc1xuXG4vKipcbiAqIE5CISBFcnJvcnMgZG8gbm90IGJsb2NrLCB0aGUgcGFyc2luZyBhbmQgZGF0YSBlbWl0dGluZyBjb250aW51ZXMgZGVzcGl0ZSBvZiB0aGUgZXJyb3JzXG4gKi9cblNtdHBSZXNwb25zZVBhcnNlci5wcm90b3R5cGUub25lcnJvciA9IGZ1bmN0aW9uICgpIHsgfVxuU210cFJlc3BvbnNlUGFyc2VyLnByb3RvdHlwZS5vbmRhdGEgPSBmdW5jdGlvbiAoKSB7IH1cblNtdHBSZXNwb25zZVBhcnNlci5wcm90b3R5cGUub25lbmQgPSBmdW5jdGlvbiAoKSB7IH1cblxuLy8gUHVibGljIEFQSVxuXG4vKipcbiAqIFF1ZXVlIHNvbWUgZGF0YSBmcm9tIHRoZSBzZXJ2ZXIgZm9yIHBhcnNpbmcuIE9ubHkgYWxsb3dlZCwgaWYgJ2VuZCcgaGFzIG5vdCBiZWVuIGNhbGxlZCB5ZXRcbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gY2h1bmsgQ2h1bmsgb2YgZGF0YSByZWNlaXZlZCBmcm9tIHRoZSBzZXJ2ZXJcbiAqL1xuU210cFJlc3BvbnNlUGFyc2VyLnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24gKGNodW5rKSB7XG4gIGlmICh0aGlzLmRlc3Ryb3llZCkge1xuICAgIHJldHVybiB0aGlzLm9uZXJyb3IobmV3IEVycm9yKCdUaGlzIHBhcnNlciBoYXMgYWxyZWFkeSBiZWVuIGNsb3NlZCwgXCJ3cml0ZVwiIGlzIHByb2hpYml0ZWQnKSlcbiAgfVxuXG4gIC8vIExpbmVzIHNob3VsZCBhbHdheXMgZW5kIHdpdGggPENSPjxMRj4gYnV0IHlvdSBuZXZlciBrbm93LCBtaWdodCBiZSBvbmx5IDxMRj4gYXMgd2VsbFxuICB2YXIgbGluZXMgPSAodGhpcy5fcmVtYWluZGVyICsgKGNodW5rIHx8ICcnKSkuc3BsaXQoL1xccj9cXG4vKVxuICB0aGlzLl9yZW1haW5kZXIgPSBsaW5lcy5wb3AoKSAvLyBub3Qgc3VyZSBpZiB0aGUgbGluZSBoYXMgY29tcGxldGVseSBhcnJpdmVkIHlldFxuXG4gIGZvciAodmFyIGkgPSAwLCBsZW4gPSBsaW5lcy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgIHRoaXMuX3Byb2Nlc3NMaW5lKGxpbmVzW2ldKVxuICB9XG59XG5cbi8qKlxuICogSW5kaWNhdGUgdGhhdCBhbGwgdGhlIGRhdGEgZnJvbSB0aGUgc2VydmVyIGhhcyBiZWVuIHJlY2VpdmVkLiBDYW4gYmUgY2FsbGVkIG9ubHkgb25jZS5cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gW2NodW5rXSBDaHVuayBvZiBkYXRhIHJlY2VpdmVkIGZyb20gdGhlIHNlcnZlclxuICovXG5TbXRwUmVzcG9uc2VQYXJzZXIucHJvdG90eXBlLmVuZCA9IGZ1bmN0aW9uIChjaHVuaykge1xuICBpZiAodGhpcy5kZXN0cm95ZWQpIHtcbiAgICByZXR1cm4gdGhpcy5vbmVycm9yKG5ldyBFcnJvcignVGhpcyBwYXJzZXIgaGFzIGFscmVhZHkgYmVlbiBjbG9zZWQsIFwiZW5kXCIgaXMgcHJvaGliaXRlZCcpKVxuICB9XG5cbiAgaWYgKGNodW5rKSB7XG4gICAgdGhpcy5zZW5kKGNodW5rKVxuICB9XG5cbiAgaWYgKHRoaXMuX3JlbWFpbmRlcikge1xuICAgIHRoaXMuX3Byb2Nlc3NMaW5lKHRoaXMuX3JlbWFpbmRlcilcbiAgfVxuXG4gIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICB0aGlzLm9uZW5kKClcbn1cblxuLy8gUHJpdmF0ZSBBUElcblxuLyoqXG4gKiBQcm9jZXNzZXMgYSBzaW5nbGUgYW5kIGNvbXBsZXRlIGxpbmUuIElmIGl0IGlzIGEgY29udGlub3VzIG9uZSAoc2xhc2ggYWZ0ZXIgc3RhdHVzIGNvZGUpLFxuICogcXVldWUgaXQgdG8gdGhpcy5fYmxvY2tcbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gbGluZSBDb21wbGV0ZSBsaW5lIG9mIGRhdGEgZnJvbSB0aGUgc2VydmVyXG4gKi9cblNtdHBSZXNwb25zZVBhcnNlci5wcm90b3R5cGUuX3Byb2Nlc3NMaW5lID0gZnVuY3Rpb24gKGxpbmUpIHtcbiAgdmFyIG1hdGNoLCByZXNwb25zZVxuXG4gIC8vIHBvc3NpYmxlIGlucHV0IHN0cmluZ3MgZm9yIHRoZSByZWdleDpcbiAgLy8gMjUwLU1FU1NBR0VcbiAgLy8gMjUwIE1FU1NBR0VcbiAgLy8gMjUwIDEuMi4zIE1FU1NBR0VcblxuICBpZiAoIWxpbmUudHJpbSgpKSB7XG4gICAgLy8gbm90aGluZyB0byBjaGVjaywgZW1wdHkgbGluZVxuICAgIHJldHVyblxuICB9XG5cbiAgdGhpcy5fYmxvY2subGluZXMucHVzaChsaW5lKVxuXG4gIGlmICgobWF0Y2ggPSBsaW5lLm1hdGNoKC9eKFxcZHszfSkoWy0gXSkoPzooXFxkK1xcLlxcZCtcXC5cXGQrKSg/OiApKT8oLiopLykpKSB7XG4gICAgdGhpcy5fYmxvY2suZGF0YS5wdXNoKG1hdGNoWzRdKVxuXG4gICAgaWYgKG1hdGNoWzJdID09PSAnLScpIHtcbiAgICAgIGlmICh0aGlzLl9ibG9jay5zdGF0dXNDb2RlICYmIHRoaXMuX2Jsb2NrLnN0YXR1c0NvZGUgIT09IE51bWJlcihtYXRjaFsxXSkpIHtcbiAgICAgICAgdGhpcy5vbmVycm9yKCdJbnZhbGlkIHN0YXR1cyBjb2RlICcgKyBtYXRjaFsxXSArXG4gICAgICAgICAgJyBmb3IgbXVsdGkgbGluZSByZXNwb25zZSAoJyArIHRoaXMuX2Jsb2NrLnN0YXR1c0NvZGUgKyAnIGV4cGVjdGVkKScpXG4gICAgICB9IGVsc2UgaWYgKCF0aGlzLl9ibG9jay5zdGF0dXNDb2RlKSB7XG4gICAgICAgIHRoaXMuX2Jsb2NrLnN0YXR1c0NvZGUgPSBOdW1iZXIobWF0Y2hbMV0pXG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3BvbnNlID0ge1xuICAgICAgICBzdGF0dXNDb2RlOiBOdW1iZXIobWF0Y2hbMV0pIHx8IDAsXG4gICAgICAgIGVuaGFuY2VkU3RhdHVzOiBtYXRjaFszXSB8fCBudWxsLFxuICAgICAgICBkYXRhOiB0aGlzLl9ibG9jay5kYXRhLmpvaW4oJ1xcbicpLFxuICAgICAgICBsaW5lOiB0aGlzLl9ibG9jay5saW5lcy5qb2luKCdcXG4nKVxuICAgICAgfVxuICAgICAgcmVzcG9uc2Uuc3VjY2VzcyA9IHJlc3BvbnNlLnN0YXR1c0NvZGUgPj0gMjAwICYmIHJlc3BvbnNlLnN0YXR1c0NvZGUgPCAzMDBcblxuICAgICAgdGhpcy5vbmRhdGEocmVzcG9uc2UpXG4gICAgICB0aGlzLl9ibG9jayA9IHtcbiAgICAgICAgZGF0YTogW10sXG4gICAgICAgIGxpbmVzOiBbXSxcbiAgICAgICAgc3RhdHVzQ29kZTogbnVsbFxuICAgICAgfVxuICAgICAgdGhpcy5fYmxvY2suc3RhdHVzQ29kZSA9IG51bGxcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5vbmVycm9yKG5ldyBFcnJvcignSW52YWxpZCBTTVRQIHJlc3BvbnNlIFwiJyArIGxpbmUgKyAnXCInKSlcbiAgICB0aGlzLm9uZGF0YSh7XG4gICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIHN0YXR1c0NvZGU6IHRoaXMuX2Jsb2NrLnN0YXR1c0NvZGUgfHwgbnVsbCxcbiAgICAgIGVuaGFuY2VkU3RhdHVzOiBudWxsLFxuICAgICAgZGF0YTogW2xpbmVdLmpvaW4oJ1xcbicpLFxuICAgICAgbGluZTogdGhpcy5fYmxvY2subGluZXMuam9pbignXFxuJylcbiAgICB9KVxuICAgIHRoaXMuX2Jsb2NrID0ge1xuICAgICAgZGF0YTogW10sXG4gICAgICBsaW5lczogW10sXG4gICAgICBzdGF0dXNDb2RlOiBudWxsXG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IFNtdHBSZXNwb25zZVBhcnNlclxuIl19