var toggleButtons = document.querySelectorAll(".toggle-button");

toggleButtons.forEach(function(button) {
  var codeBlock = button.parentElement.nextElementSibling;

  button.addEventListener("click", function() {
    if (codeBlock.style.maxHeight) {
      // 当前展开状态，折叠
	  button.classList.remove("expanded");
      codeBlock.style.maxHeight = null;
      button.textContent = "展开";
    } else {
      // 当前折叠状态，展开
      codeBlock.style.maxHeight = codeBlock.scrollHeight + "px";
	  button.classList.add("expanded");
      button.textContent = "折叠";
    }
  });
});