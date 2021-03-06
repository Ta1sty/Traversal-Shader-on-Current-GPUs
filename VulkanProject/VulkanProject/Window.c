#include "Window.h"

#include <GLFW/glfw3.h>
#include "Util.h"
#include "Globals.h"

void init_window(GLFWwindow** window)
{
	glfwInit();

	glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);
	glfwWindowHint(GLFW_RESIZABLE, GLFW_TRUE);

	*window = glfwCreateWindow(WINDOW_WIDTH, WINDOW_HEIGHT, "Vulkan", NULL, NULL);
	if (window == NULL) error("Failed to create Window\n");
}

void destroy_window(GLFWwindow* window)
{
	if(window != NULL) glfwDestroyWindow(window);
	glfwTerminate();
}
